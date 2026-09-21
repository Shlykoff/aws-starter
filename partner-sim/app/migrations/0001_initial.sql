-- 0001: the first schema version. This folder is where the database schema lives: read the
-- files in order to see what the tables looked like at each version (app/migrate.py applies them).
--
-- Rules for every file here:
--   * Never edit a file that has been applied somewhere. Change the schema with a NEW file
--     (0002_..., 0003_...): databases that already ran this one will not run it again.
--   * No BEGIN / COMMIT / ROLLBACK inside: the runner wraps each file in one transaction.
--
-- This file is special in one way. Databases created before migrations existed already have
-- these tables but report schema version 0, so this file also runs on them, and must change
-- nothing there except the version: hence IF NOT EXISTS on everything. Later files do NOT
-- need to be written like that, because the runner applies each of them exactly once.

-- outcome and code are tied together the same way as in the reply: a code exactly when rejected.
CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY,
    received_at  TEXT    NOT NULL,
    message_id   TEXT,
    recipient    TEXT,
    subject      TEXT,
    outcome      TEXT    NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
    code         TEXT,
    http_status  INTEGER NOT NULL,
    request_xml  TEXT    NOT NULL,
    reply_xml    TEXT    NOT NULL,
    problems     TEXT    NOT NULL,
    CHECK ((outcome = 'accepted' AND code IS NULL) OR (outcome = 'rejected' AND code IS NOT NULL))
);

-- This index is what makes "answer the same MessageId only once" atomic: when two requests
-- with the same id arrive at the same moment, the database lets exactly one INSERT through.
-- Schema-invalid submissions are left out on purpose: the contract validates BEFORE it looks
-- for duplicates (steps 3 and 4), and such a document may not even carry a real MessageId.
-- Their id is still stored, for the inbox, but it is not a key.
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_message_id
    ON messages (message_id)
    WHERE message_id IS NOT NULL AND code IS NOT 'SCHEMA_INVALID';
