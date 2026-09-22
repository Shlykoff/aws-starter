"""What the recipient does with one submission, once the HTTP layer has accepted the request.

The order of the steps is fixed by contracts/partner-api.md. The HTTP layer (api.py) does
steps 1-3, this module does 4-8:

    1. check the API key                        401   (api.py)
    2. check the content type                   415   (api.py)
    3. check the size                           413   (api.py)
    4. parse: not well-formed, or any DOCTYPE   400   MALFORMED_XML
    5. validate against submission.xsd          422   SCHEMA_INVALID
    6. this MessageId was answered before       the stored answer again
    7. the recipient's own rules on the Subject [reject] 422 RECIPIENT_REJECTED
                                                [fail]   503, nothing stored
    8. otherwise                                200   Accepted

(The contract lists six steps because it groups 1-3 as one. The order is the same.)

Never logged here: the request, the reply, or any text taken from them (not even the MessageId,
which for a broken submission is whatever the sender typed). Only the outcome is logged.
"""

import logging
from dataclasses import dataclass
from datetime import datetime

from app.models import Finding, MessageDetail, NewMessage
from app.replies import RejectCode, accepted_reply, rejected_reply, rule_violations
from app.storage import MessageStore
from app.timeutil import format_utc, utc_now
from app.validation import SchemaValidator
from app.xml_input import (
    DoctypeNotAllowed,
    MalformedXml,
    SubmissionFields,
    is_ulid,
    parse_xml,
    read_fields,
)

log = logging.getLogger("partner_sim")

REJECT_TRIGGER = "[reject]"
FAIL_TRIGGER = "[fail]"

_REPLACEMENT_CHARACTER = "\N{REPLACEMENT CHARACTER}"  # U+FFFD, what a reader sees for a bad byte

_NOTHING_READ = SubmissionFields(message_id=None, sender=None, recipient=None, subject=None)


@dataclass(frozen=True)
class Answer:
    """What to send back. `reply_xml` is None for the answer without a body (503)."""

    status_code: int
    reply_xml: str | None
    retry_after_seconds: int | None = None


class SubmissionService:
    def __init__(
        self, store: MessageStore, submission_schema: SchemaValidator, reply_schema: SchemaValidator
    ) -> None:
        self._store = store
        self._submission_schema = submission_schema
        self._reply_schema = reply_schema

    def handle(self, body: bytes) -> Answer:
        received_at = utc_now()

        # Step 4: parse.
        try:
            root = parse_xml(body)
        except MalformedXml as exc:
            # The reply gets a fixed sentence, never the parser's own message: nothing of the
            # input is echoed back. The parser's message goes to the stored findings.
            description = (
                "The document carries a DOCTYPE, which is not allowed"
                if isinstance(exc, DoctypeNotAllowed)
                else "The document is not well-formed XML"
            )
            reply = rejected_reply(received_at, None, "MALFORMED_XML", description)
            finding = Finding(line=exc.line, message=exc.message)
            return self._record(
                received_at, body, _NOTHING_READ, 400, "MALFORMED_XML", reply, [finding]
            )

        fields = read_fields(root)

        # Step 5: validate.
        findings = self._submission_schema.validate(root)
        if findings:
            first = findings[0]
            description = (f"Line {first.line}: " if first.line else "") + first.message
            # RelatesTo only if what the sender wrote is a real ULID (the reply schema demands it).
            relates_to = fields.message_id if is_ulid(fields.message_id) else None
            reply = rejected_reply(received_at, relates_to, "SCHEMA_INVALID", description)
            return self._record(received_at, body, fields, 422, "SCHEMA_INVALID", reply, findings)

        # The document is valid, so these were found. (For the type checker and the reader.)
        assert fields.message_id is not None and fields.subject is not None

        # Step 6: the same MessageId again: repeat the earlier answer, store and process nothing.
        earlier = self._store.find_answered(fields.message_id)
        if earlier is not None:
            log.info("duplicate submission: the stored answer is repeated")
            return _repeat(earlier)

        # Step 7: the recipient's own rules. [reject] is checked first: the contract lists it first.
        if REJECT_TRIGGER in fields.subject:
            description = (
                f"The subject contains {REJECT_TRIGGER}, which the recipient's rules refuse"
            )
            reply = rejected_reply(
                received_at, fields.message_id, "RECIPIENT_REJECTED", description
            )
            finding = Finding(line=None, message=description)
            return self._record(
                received_at, body, fields, 422, "RECIPIENT_REJECTED", reply, [finding]
            )
        if FAIL_TRIGGER in fields.subject:
            # Simulates an outage. Nothing is stored, so the sender's retry is processed as new.
            log.info("answered 503 on purpose (%s trigger); nothing stored", FAIL_TRIGGER)
            return Answer(status_code=503, reply_xml=None, retry_after_seconds=1)

        # Step 8: accepted.
        reply = accepted_reply(received_at, fields.message_id)
        return self._record(received_at, body, fields, 200, None, reply, [])

    def _record(
        self,
        received_at: datetime,
        body: bytes,
        fields: SubmissionFields,
        http_status: int,
        code: RejectCode | None,
        reply_xml: str,
        findings: list[Finding],
    ) -> Answer:
        """Store the outcome and answer with it. `code` is None for Accepted."""
        message = NewMessage(
            received_at=format_utc(received_at),
            message_id=fields.message_id,
            sender=fields.sender,
            recipient=fields.recipient,
            subject=fields.subject,
            outcome="accepted" if code is None else "rejected",
            code=code,
            http_status=http_status,
            request_xml=_to_text(body),
            reply_xml=self._checked(reply_xml),
            problems=findings,
        )
        # If a parallel request with the same MessageId got in first, the database refuses our
        # row and hands back the earlier one: we then repeat its answer, not ours.
        earlier = self._store.add(message)
        if earlier is not None:
            log.info("duplicate submission (parallel): the stored answer is repeated")
            return _repeat(earlier)
        log.info("submission answered: status %s, %s", http_status, code or "Accepted")
        return Answer(status_code=http_status, reply_xml=message.reply_xml)

    def _checked(self, reply_xml: str) -> str:
        """Refuse to send a reply that breaks reply.xsd or the Code/Description rule.

        Only a bug in this file can make it fail. Failing loudly (HTTP 500) is better than
        handing the sender a protocol violation, which it would treat as a temporary error.
        """
        root = parse_xml(reply_xml.encode("utf-8"))
        if self._reply_schema.validate(root) or rule_violations(root):
            raise RuntimeError("the simulator built an invalid Reply")
        return reply_xml


def _repeat(earlier: MessageDetail) -> Answer:
    return Answer(status_code=earlier.http_status, reply_xml=earlier.reply_xml)


def _to_text(body: bytes) -> str:
    """The request as text, for storage. Bytes that are not UTF-8 become U+FFFD, and so does NUL:
    a NUL character is useless to a reader and awkward for HTML."""
    return body.decode("utf-8", errors="replace").replace("\x00", _REPLACEMENT_CHARACTER)
