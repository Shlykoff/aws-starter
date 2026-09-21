"""What happens when the person plays the client: a decision is made, or sent again.

The order of the steps for a new decision is fixed on purpose:

    1. build the event and check it against event.xsd   (nothing invalid is ever stored)
    2. store it as `pending`                            (so a crash cannot lose the decision)
    3. send it once                                     (no retry, no timer: a person decides)
    4. write down how it went

Never logged here: the reason, the event, the token, the signature. Only the outcome.
"""

import logging

from app.events import Decision, build_event
from app.models import MessageDetail, NewDecisionEvent, StoredEvent
from app.storage import MessageStore
from app.timeutil import format_utc, utc_now
from app.validation import SchemaValidator
from app.webhook import WebhookClient

log = logging.getLogger("partner_sim")


class DecisionService:
    def __init__(
        self, store: MessageStore, event_schema: SchemaValidator, webhook: WebhookClient
    ) -> None:
        self._store = store
        self._event_schema = event_schema
        self._webhook = webhook

    def decide(self, message: MessageDetail, decision: Decision, reason: str | None) -> StoredEvent:
        """A NEW event (new EventId, new OccurredAt) for an accepted message; sent once.

        `reason` comes from clean_reason(). Raises EventInvalid if the built document breaks
        event.xsd (a bug): then nothing is stored and nothing is sent.
        """
        # An accepted message always has a valid MessageId, or the schema would have refused it.
        assert message.message_id is not None
        built = build_event(self._event_schema, message.message_id, decision, reason, utc_now())
        stored = self._store.add_event(
            NewDecisionEvent(
                message_row_id=message.id,
                event_id=built.event_id,
                decision=decision,
                reason=reason,
                occurred_at=built.occurred_at,
                event_xml=built.xml,
            )
        )
        return self._send(stored)

    def resend(self, event: StoredEvent) -> StoredEvent:
        """The SAME event again: the same EventId and the same stored document. Only the
        timestamp and the signature (headers, made fresh by the webhook client) are new."""
        return self._send(event)

    def _send(self, event: StoredEvent) -> StoredEvent:
        result = self._webhook.send(event.event_xml.encode("utf-8"))
        updated = self._store.record_attempt(
            event.id,
            delivered=result.delivered,
            http_status=result.http_status,
            at=format_utc(utc_now()),
        )
        log.info(
            "decision event %s: attempt %d, %s",
            "delivered" if result.delivered else "not delivered",
            updated.attempts,
            f"HTTP {result.http_status}" if result.http_status is not None else "no answer",
        )
        return updated
