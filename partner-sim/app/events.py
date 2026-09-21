"""Building the DecisionEvent document (contracts/xsd/event.xsd).

The event says what the CLIENT did with a delivered message: approved it or declined it. The
recipient (this simulator) sends it to the sender's webhook (contracts/webhook-api.md).

The XML is assembled with lxml elements, never with string formatting: the reason is free text
typed by a person, and lxml escapes `&`, `<` and `>` correctly. The finished document is checked
against event.xsd before anybody stores or sends it.
"""

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from lxml import etree

from app.timeutil import format_utc
from app.validation import SchemaValidator
from app.xml_input import MalformedXml, parse_xml

log = logging.getLogger("partner_sim")

EVENT_NS = "urn:aws-starter:event:v1"
REASON_MAX = 500  # Text500 in common-types.xsd: 1 to 500 characters

Decision = Literal["Approved", "Declined"]
DECISIONS: tuple[Decision, ...] = ("Approved", "Declined")

# XML 1.0 can carry only these characters (its "Char" rule): tab, line feed, carriage return, and
# everything from space up, except the surrogate halves and U+FFFE / U+FFFF. Other control
# characters (for example a bell, U+0007) cannot be written into XML at all, not even escaped.
_NOT_XML_CHARACTER = re.compile(r"[^\t\n\r\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")


class ReasonRejected(ValueError):
    """The reason cannot go into an event. The text is written for the person at the keyboard."""


class EventInvalid(Exception):
    """The document we built breaks event.xsd. Only a bug in this file can cause it."""


@dataclass(frozen=True)
class BuiltEvent:
    event_id: str
    occurred_at: str  # the same text as inside the document
    xml: str


def clean_reason(raw: str) -> str | None:
    """The reason as it will go into the event, or None when there is none.

    Surrounding white space is dropped and a reason that is only white space counts as none
    (the schema wants 1 to 500 characters, so an empty <Reason/> would be refused).
    Raises ReasonRejected for a reason that is too long or holds a character XML cannot carry.
    """
    # Looked for BEFORE stripping: str.strip() also removes a few control characters at the
    # edges (U+001C to U+001F), and those must be refused, not silently dropped.
    bad = _NOT_XML_CHARACTER.search(raw)
    if bad is not None:
        raise ReasonRejected(
            f"The reason contains a character that XML cannot carry (U+{ord(bad.group()):04X}). "
            "Remove it and try again."
        )
    reason = raw.strip()
    if len(reason) > REASON_MAX:
        raise ReasonRejected(
            f"The reason is {len(reason)} characters long; the limit is {REASON_MAX}."
        )
    return reason or None


def build_event(
    schema: SchemaValidator,
    relates_to: str,
    decision: Decision,
    reason: str | None,
    occurred_at: datetime,
) -> BuiltEvent:
    """A new event with a fresh EventId. `reason` comes from clean_reason().

    `relates_to` is the MessageId (the ULID) of the submission the event is about.
    Raises EventInvalid if the document does not match event.xsd.
    """
    event_id = str(uuid.uuid4())  # lower-case, as the schema's Uuid type wants
    occurred_at_text = format_utc(occurred_at)

    def child(name: str, text: str) -> None:
        etree.SubElement(root, f"{{{EVENT_NS}}}{name}").text = text

    root = etree.Element(f"{{{EVENT_NS}}}DecisionEvent", nsmap={None: EVENT_NS}, version="1")
    child("EventId", event_id)
    child("OccurredAt", occurred_at_text)
    child("RelatesTo", relates_to)
    child("Decision", decision)
    if reason is not None:
        child("Reason", reason)
    # pretty_print: one element per line, so a finding's line number points at the element.
    xml = etree.tostring(root, xml_declaration=True, encoding="UTF-8", pretty_print=True).decode(
        "utf-8"
    )

    _check(schema, xml)
    return BuiltEvent(event_id=event_id, occurred_at=occurred_at_text, xml=xml)


def _check(schema: SchemaValidator, xml: str) -> None:
    """Validate the document exactly as it will be sent: serialised, then parsed again."""
    try:
        root = parse_xml(xml.encode("utf-8"))
    except MalformedXml:
        log.error("the simulator built a DecisionEvent that is not well-formed")
        raise EventInvalid("the simulator built a DecisionEvent that is not well-formed") from None
    findings = schema.validate(root)
    if findings:
        # Only the lines: the messages of the validator quote the offending value, and the
        # reason is text a person typed. The lines are enough to find the element.
        lines = ", ".join(str(finding.line) for finding in findings)
        log.error("the simulator built an invalid DecisionEvent (line %s)", lines)
        raise EventInvalid("the simulator built a DecisionEvent that does not match event.xsd")
