"""SQLite storage (standard library, no ORM).

One table, `messages`. Every processed submission is a row, except the [fail] ones.

Threads: FastAPI runs the request code in a pool of threads. Each method here opens its own
short-lived connection, uses it and closes it, so no connection is ever shared between threads.
Opening a SQLite connection is cheap, and the file is in WAL mode, so readers (the inbox) and
the writer (a new submission) do not block each other.
"""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from app.models import Finding, MessageDetail, MessageSummary, NewMessage

# outcome and code are tied together the same way as in the reply: a code exactly when rejected.
_SCHEMA = """
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
"""

_SQLITE_MAX_ID = 2**63 - 1


class MessageStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path

    def initialize(self) -> None:
        """Create the folder, the table and the index if they are not there yet."""
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            # WAL is a property of the file: set once, it stays.
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # timeout: wait up to 5 s for a writer instead of failing at once with "database is locked".
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            with conn:  # commits when the block ends, rolls back when it raises
                yield conn
        finally:
            conn.close()  # the `with conn` above does not close it

    def find_answered(self, message_id: str) -> MessageDetail | None:
        """The stored row that answered this MessageId, if any."""
        with self._connect() as conn:
            row = conn.execute(
                # Same condition as the unique index, so that the index can serve this lookup.
                "SELECT * FROM messages WHERE message_id = ? AND code IS NOT 'SCHEMA_INVALID'",
                (message_id,),
            ).fetchone()
        return None if row is None else _detail(row)

    def add(self, new: NewMessage) -> MessageDetail | None:
        """Store a message.

        Returns None when it was stored. Returns the EARLIER row when another request already
        answered the same MessageId (the unique index refused this insert): the caller must
        then repeat that answer instead of its own.
        """
        problems_json = json.dumps([{"line": f.line, "message": f.message} for f in new.problems])
        try:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO messages (received_at, message_id, recipient, subject, outcome,"
                    " code, http_status, request_xml, reply_xml, problems)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        new.received_at,
                        new.message_id,
                        new.recipient,
                        new.subject,
                        new.outcome,
                        new.code,
                        new.http_status,
                        new.request_xml,
                        new.reply_xml,
                        problems_json,
                    ),
                )
        except sqlite3.IntegrityError:
            # Either the unique index (a duplicate: expected) or a CHECK constraint (a bug: raise).
            earlier = self.find_answered(new.message_id) if new.message_id is not None else None
            if earlier is None:
                raise
            return earlier
        return None

    def list_recent(self, limit: int = 100) -> list[MessageSummary]:
        with self._connect() as conn:
            rows = conn.execute(
                # Not SELECT *: the two XML columns can be 64 KiB each; the list does not need them.
                "SELECT id, received_at, message_id, recipient, subject, outcome, code, http_status"
                " FROM messages ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [_summary(row) for row in rows]

    def get(self, row_id: int) -> MessageDetail | None:
        if not 1 <= row_id <= _SQLITE_MAX_ID:  # SQLite cannot bind bigger numbers
            return None
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM messages WHERE id = ?", (row_id,)).fetchone()
        return None if row is None else _detail(row)


def _summary(row: sqlite3.Row) -> MessageSummary:
    return MessageSummary(
        id=row["id"],
        received_at=row["received_at"],
        message_id=row["message_id"],
        recipient=row["recipient"],
        subject=row["subject"],
        outcome=row["outcome"],
        code=row["code"],
        http_status=row["http_status"],
    )


def _detail(row: sqlite3.Row) -> MessageDetail:
    return MessageDetail(
        id=row["id"],
        received_at=row["received_at"],
        message_id=row["message_id"],
        recipient=row["recipient"],
        subject=row["subject"],
        outcome=row["outcome"],
        code=row["code"],
        http_status=row["http_status"],
        request_xml=row["request_xml"],
        reply_xml=row["reply_xml"],
        problems=[
            Finding(line=p["line"], message=p["message"]) for p in json.loads(row["problems"])
        ],
    )
