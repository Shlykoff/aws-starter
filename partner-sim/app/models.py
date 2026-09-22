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
    sender: str | None  # Header/Sender/Name: the requester's e-mail address
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
    sender: str | None
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


@dataclass(frozen=True)
class NewDecisionEvent:
    """A decision event that was built and checked, ready to be stored (state pending)."""

    message_row_id: int  # messages.id of the message it is about (NOT its MessageId text)
    event_id: str
    decision: str  # "Approved" or "Declined"
    reason: str | None
    occurred_at: str  # UTC, e.g. 2026-09-21T10:11:12.123Z
    event_xml: str


@dataclass(frozen=True)
class StoredEvent(NewDecisionEvent):
    """A stored event: what was built, plus how sending it went so far."""

    id: int
    state: str  # "pending", "delivered" or "failed": the result of the LAST attempt
    attempts: int
    last_status: int | None  # HTTP status of the last attempt; None when nobody answered
    last_attempt_at: str | None


@dataclass(frozen=True)
class DecisionOverview:
    """What the inbox shows for one message: how many events, and the newest one."""

    count: int
    last_decision: str
    last_state: str
