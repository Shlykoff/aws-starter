"""SQLite storage (standard library, no ORM).

Two tables. `messages`: every processed submission is a row, except the [fail] ones.
`decision_events`: what the client decided about an accepted message and how sending it went.
The schema itself is not in this file: it lives in the SQL files in app/migrations/, and
initialize() applies them (see app/migrate.py).

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

from app.migrate import migrate
from app.models import (
    DecisionOverview,
    Finding,
    MessageDetail,
    MessageSummary,
    NewDecisionEvent,
    NewMessage,
    StoredEvent,
)

_SQLITE_MAX_ID = 2**63 - 1


class MessageStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path

    def initialize(self) -> None:
        """Create the folder and the file, switch on WAL, bring the schema up to date."""
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            # WAL is a property of the file: set once, it stays. It cannot be switched on inside
            # a transaction, so it is not part of a migration.
            conn.execute("PRAGMA journal_mode=WAL")
        migrate(self._db_path)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # timeout: wait up to 5 s for a writer instead of failing at once with "database is locked".
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        # SQLite ignores REFERENCES unless this is switched on, and it is per connection.
        # With it, an event cannot be stored for a message that does not exist.
        conn.execute("PRAGMA foreign_keys = ON")
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
                    "INSERT INTO messages (received_at, message_id, sender, recipient, subject,"
                    " outcome, code, http_status, request_xml, reply_xml, problems)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        new.received_at,
                        new.message_id,
                        new.sender,
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
                "SELECT id, received_at, message_id, sender, recipient, subject, outcome, code,"
                " http_status FROM messages ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [_summary(row) for row in rows]

    def get(self, row_id: int) -> MessageDetail | None:
        if not 1 <= row_id <= _SQLITE_MAX_ID:  # SQLite cannot bind bigger numbers
            return None
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM messages WHERE id = ?", (row_id,)).fetchone()
        return None if row is None else _detail(row)

    # --- Decision events (the client's side) -------------------------------------------------

    def add_event(self, new: NewDecisionEvent) -> StoredEvent:
        """Store a new event as `pending` (nobody has tried to send it yet) and return it."""
        with self._connect() as conn:
            cursor = conn.execute(
                "INSERT INTO decision_events (message_id, event_id, decision, reason, occurred_at,"
                " event_xml, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                (
                    new.message_row_id,
                    new.event_id,
                    new.decision,
                    new.reason,
                    new.occurred_at,
                    new.event_xml,
                ),
            )
            row = conn.execute(
                "SELECT * FROM decision_events WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        return _event(row)

    def record_attempt(
        self, event_row_id: int, *, delivered: bool, http_status: int | None, at: str
    ) -> StoredEvent:
        """Write down the result of one attempt to send: the state is the result of the LAST one."""
        with self._connect() as conn:
            conn.execute(
                # attempts + 1 is computed by the database, so two attempts at the same moment
                # are both counted.
                "UPDATE decision_events SET state = ?, attempts = attempts + 1, last_status = ?,"
                " last_attempt_at = ? WHERE id = ?",
                ("delivered" if delivered else "failed", http_status, at, event_row_id),
            )
            row = conn.execute(
                "SELECT * FROM decision_events WHERE id = ?", (event_row_id,)
            ).fetchone()
        return _event(row)

    def events_of(self, message_row_id: int) -> list[StoredEvent]:
        """The events of one message, the newest first."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM decision_events WHERE message_id = ? ORDER BY id DESC",
                (message_row_id,),
            ).fetchall()
        return [_event(row) for row in rows]

    def get_event(self, message_row_id: int, event_id: str) -> StoredEvent | None:
        """One event of one message. The message is part of the question on purpose: an event
        id from the address of another message finds nothing."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM decision_events WHERE message_id = ? AND event_id = ?",
                (message_row_id, event_id),
            ).fetchone()
        return None if row is None else _event(row)

    def decision_overview(self, from_message_row_id: int) -> dict[int, DecisionOverview]:
        """For the inbox: per message (row id >= the given one) the number of events and the
        decision and state of the newest event. Messages without events are not in the result."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT e.message_id, c.count, e.decision, e.state FROM decision_events e"
                " JOIN (SELECT message_id, COUNT(*) AS count, MAX(id) AS newest_id"
                "       FROM decision_events WHERE message_id >= ? GROUP BY message_id) c"
                "   ON e.id = c.newest_id",
                (from_message_row_id,),
            ).fetchall()
        return {
            row["message_id"]: DecisionOverview(row["count"], row["decision"], row["state"])
            for row in rows
        }

    # --- Admin (operator only) ----------------------------------------------------------------

    def reset(self) -> None:
        """Wipe every row, for an operator clearing test data out of a running instance.

        decision_events first: it has a foreign key to messages.id, and foreign_keys=ON
        (see _connect) would refuse deleting a message that still has an event pointing at it.
        Both deletes run in the one transaction _connect already opens, so a reset is all-or-
        nothing.
        """
        with self._connect() as conn:
            conn.execute("DELETE FROM decision_events")
            conn.execute("DELETE FROM messages")


def _event(row: sqlite3.Row) -> StoredEvent:
    return StoredEvent(
        message_row_id=row["message_id"],  # the column is called message_id; it is messages.id
        event_id=row["event_id"],
        decision=row["decision"],
        reason=row["reason"],
        occurred_at=row["occurred_at"],
        event_xml=row["event_xml"],
        id=row["id"],
        state=row["state"],
        attempts=row["attempts"],
        last_status=row["last_status"],
        last_attempt_at=row["last_attempt_at"],
    )


def _summary(row: sqlite3.Row) -> MessageSummary:
    return MessageSummary(
        id=row["id"],
        received_at=row["received_at"],
        message_id=row["message_id"],
        sender=row["sender"],
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
        sender=row["sender"],
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
