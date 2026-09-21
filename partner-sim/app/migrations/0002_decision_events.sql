-- 0002: the client's decisions. After a message was accepted, a person can press "Approve" or
-- "Decline" on its page; the simulator then sends a DecisionEvent to the sender's webhook.
-- One row per event, so that "Send again" can send exactly the same document again.

CREATE TABLE decision_events (
    id               INTEGER PRIMARY KEY,
    -- The ROW id of the message (messages.id), not its MessageId text. Enforced: storage.py
    -- switches foreign keys on for every connection.
    message_id       INTEGER NOT NULL REFERENCES messages (id),
    -- The EventId inside the document. UNIQUE: one row per event, however often it is sent.
    event_id         TEXT    NOT NULL UNIQUE,
    decision         TEXT    NOT NULL CHECK (decision IN ('Approved', 'Declined')),
    reason           TEXT,
    occurred_at      TEXT    NOT NULL,
    -- The exact document that was validated. A resend sends these same bytes, only with a new
    -- timestamp and signature in the headers.
    event_xml        TEXT    NOT NULL,
    -- The result of the LAST attempt. pending: stored, nobody has tried to send it yet.
    state            TEXT    NOT NULL CHECK (state IN ('pending', 'delivered', 'failed')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    -- The HTTP status of the last attempt; NULL when nobody answered (or no attempt yet).
    last_status      INTEGER,
    last_attempt_at  TEXT
);

-- The message page lists the events of one message.
CREATE INDEX ix_decision_events_message_id ON decision_events (message_id);
