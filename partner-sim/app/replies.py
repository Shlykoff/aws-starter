"""Building the Reply document (contracts/xsd/reply.xsd).

Reply text is assembled with lxml elements, never with string formatting: the Description can
contain text taken from the submission (the validator quotes the offending value), and lxml
escapes it correctly.
"""

import uuid
from datetime import datetime
from typing import Literal

from lxml import etree

from app.timeutil import format_utc

REPLY_NS = "urn:aws-starter:reply:v1"
_DESCRIPTION_MAX = 500  # Text500 in common-types.xsd

RejectCode = Literal["MALFORMED_XML", "SCHEMA_INVALID", "RECIPIENT_REJECTED"]


def accepted_reply(received_at: datetime, relates_to: str | None) -> str:
    """Status Accepted. No Code and no Description: the rule of the contract, by construction."""
    return _build(received_at, relates_to, status="Accepted", code=None, description=None)


def rejected_reply(
    received_at: datetime, relates_to: str | None, code: RejectCode, description: str
) -> str:
    """Status Rejected. Code and Description are always present."""
    return _build(
        received_at,
        relates_to,
        status="Rejected",
        code=code,
        description=description[:_DESCRIPTION_MAX],
    )


def _build(
    received_at: datetime,
    relates_to: str | None,
    status: str,
    code: str | None,
    description: str | None,
) -> str:
    def child(parent: etree._Element, name: str, text: str | None = None) -> etree._Element:
        element = etree.SubElement(parent, f"{{{REPLY_NS}}}{name}")
        element.text = text
        return element

    root = etree.Element(f"{{{REPLY_NS}}}Reply", nsmap={None: REPLY_NS}, version="1")
    child(root, "MessageId", str(uuid.uuid4()))  # fresh, lower-case UUID: the recipient's own id
    if relates_to is not None:
        child(root, "RelatesTo", relates_to)
    child(root, "ReceivedAt", format_utc(received_at))
    result = child(root, "Result")
    child(result, "Status", status)
    if code is not None:
        child(result, "Code", code)
    if description is not None:
        child(result, "Description", description)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8").decode("utf-8")


def rule_violations(root: etree._Element) -> list[str]:
    """The rule XSD 1.0 cannot express: Code and Description exist exactly when Rejected.

    Works on any parsed Reply, whoever built it. Returns what is wrong; empty means fine.
    """
    ns = {"r": REPLY_NS}
    status = root.findtext("r:Result/r:Status", namespaces=ns)
    has_code = root.find("r:Result/r:Code", ns) is not None
    has_description = root.find("r:Result/r:Description", ns) is not None
    rejected = status == "Rejected"

    problems = []
    if has_code != rejected:
        problems.append(
            f"Code is {'missing' if rejected else 'present'} but the status is {status}"
        )
    if has_description != rejected:
        problems.append(
            f"Description is {'missing' if rejected else 'present'} but the status is {status}"
        )
    return problems
