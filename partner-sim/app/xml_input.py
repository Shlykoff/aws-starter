"""Reading XML that comes from outside: a hardened parser, the DOCTYPE ban, field lookup.

Policy (contracts/partner-api.md, step 2): a document that is not well-formed, or that carries
ANY DOCTYPE, is refused. Without a DOCTYPE there are no custom entities, so external-entity
(XXE) and entity-expansion ("billion laughs") attacks have nothing to work with.
"""

import re
from dataclasses import dataclass

from lxml import etree

SUBMISSION_NS = "urn:aws-starter:submission:v1"

# Same pattern as the Ulid type in common-types.xsd. Used with fullmatch(), never with `$`
# (which would also accept a trailing newline).
_ULID = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}")

_DOCTYPE_MARKER = b"<!DOCTYPE"


class MalformedXml(Exception):
    """Not well-formed. `line` is where, when known."""

    def __init__(self, message: str, line: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.line = line


class DoctypeNotAllowed(MalformedXml):
    """The document carries a DOCTYPE. Well-formed or not, the policy refuses it."""


def hardened_parser(**extra: object) -> etree.XMLParser:
    """A fresh parser with every risky feature switched off.

    A new parser per call (it costs microseconds) means no parser object is ever shared
    between threads, so there is nothing to lock.
    """
    return etree.XMLParser(
        resolve_entities=False,  # never replace &name; with its definition
        no_network=True,  # never fetch anything over the network
        load_dtd=False,  # never read a DTD, internal or external
        dtd_validation=False,
        attribute_defaults=False,
        huge_tree=False,  # keep libxml2's limits on depth and text size
        recover=False,  # broken XML is an error, not something to guess around
        **extra,
    )


def _parse(body: bytes, parser: etree.XMLParser) -> etree._Element:
    # Guard 1: look at the raw bytes before the parser sees them at all.
    marker_at = body.find(_DOCTYPE_MARKER)
    if marker_at != -1:
        line = body.count(b"\n", 0, marker_at) + 1
        raise DoctypeNotAllowed("A DOCTYPE declaration is not allowed", line)

    try:
        root = etree.fromstring(body, parser)
    except etree.XMLSyntaxError as exc:
        raise MalformedXml(exc.msg, exc.lineno) from exc

    # Guard 2: look at the parsed document. The raw check above cannot see a DOCTYPE in a
    # document encoded as UTF-16, where every character is two bytes; the parser can.
    docinfo = root.getroottree().docinfo
    if docinfo.doctype or docinfo.internalDTD is not None or docinfo.externalDTD is not None:
        raise DoctypeNotAllowed("A DOCTYPE declaration is not allowed")
    return root


def parse_xml(body: bytes) -> etree._Element:
    """Parse a document received from a sender. Raises MalformedXml."""
    return _parse(body, hardened_parser())


def pretty_print(text: str) -> str:
    """Re-indent XML for display. If it cannot be parsed safely, return the text unchanged.

    The stored text is never altered; this only changes what a person sees.
    """
    try:
        # encoding="utf-8": `text` is already decoded, so ignore what the XML declaration says.
        parser = hardened_parser(remove_blank_text=True, encoding="utf-8")
        root = _parse(text.encode("utf-8"), parser)
    except MalformedXml:
        return text
    return etree.tostring(root.getroottree(), pretty_print=True, encoding="unicode")


@dataclass(frozen=True)
class SubmissionFields:
    """The four values the simulator cares about. None where the document has no such element."""

    message_id: str | None
    sender: str | None  # Header/Sender/Name: the requester's e-mail address (PartyName allows @)
    recipient: str | None
    subject: str | None


def read_fields(root: etree._Element) -> SubmissionFields:
    """Best-effort lookup; also used on documents that failed the schema (RelatesTo, inbox)."""
    ns = {"s": SUBMISSION_NS}

    def text_at(path: str) -> str | None:
        found = root.find(path, ns)
        return None if found is None else (found.text or "")

    return SubmissionFields(
        message_id=text_at("s:Header/s:MessageId"),
        sender=text_at("s:Header/s:Sender/s:Name"),
        recipient=text_at("s:Header/s:Recipient/s:Name"),
        subject=text_at("s:Content/s:Subject"),
    )


def is_ulid(value: str | None) -> bool:
    return value is not None and _ULID.fullmatch(value) is not None
