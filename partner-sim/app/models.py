"""Plain data types passed between the layers. No behaviour, no imports from the rest of app/."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Finding:
    """One thing the validator (or the parser) did not like. `line` is None when unknown."""

    line: int | None
    message: str


@dataclass(frozen=True)
class NewMessage:
    """A processed submission, ready to be stored."""

    received_at: str  # UTC, e.g. 2026-09-21T10:11:12.123Z
    message_id: str | None  # the MessageId text of the submission, None when it could not be read
    recipient: str | None
    subject: str | None
    outcome: str  # "accepted" or "rejected"
    code: str | None  # the reply Code; None exactly when the outcome is "accepted"
    http_status: int
    request_xml: str
    reply_xml: str
    problems: list[Finding]


@dataclass(frozen=True)
class MessageSummary:
    """What the inbox list needs. Leaves out the two XML texts, which can be large."""

    id: int
    received_at: str
    message_id: str | None
    recipient: str | None
    subject: str | None
    outcome: str
    code: str | None
    http_status: int


@dataclass(frozen=True)
class MessageDetail(MessageSummary):
    """One stored message with everything, for the detail page and for repeating an answer."""

    request_xml: str
    reply_xml: str
    problems: list[Finding]
