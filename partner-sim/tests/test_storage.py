"""The SQLite storage: the table, the unique index, atomic idempotency, restart, ordering."""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from helpers import API_KEY, SCHEMA_DIR, UI_AUTH, all_rows, make_submission, ulid

from app.models import Finding, NewMessage
from app.service import SubmissionService
from app.storage import MessageStore
from app.validation import SchemaValidator


def new_message(message_id: str | None = "A", **changes) -> NewMessage:
    values = {
        "received_at": "2026-09-21T10:11:12.000Z",
        "message_id": message_id,
        "sender": "s@example.com",
        "recipient": "r",
        "subject": "s",
        "outcome": "accepted",
        "code": None,
        "http_status": 200,
        "request_xml": "<a/>",
        "reply_xml": "<b/>",
        "problems": [],
    }
    values.update(changes)
    return NewMessage(**values)


@pytest.fixture
def store(tmp_path) -> MessageStore:
    store = MessageStore(tmp_path / "sub" / "partner.db")  # the folder does not exist yet
    store.initialize()
    return store


def test_initialize_creates_the_folder_the_table_and_wal_mode(store):
    conn = sqlite3.connect(store._db_path)
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        columns = [row[1] for row in conn.execute("PRAGMA table_info(messages)")]
    finally:
        conn.close()
    # sender is last: migration 0003 ALTERs it onto the end of the table.
    assert columns == [
        "id", "received_at", "message_id", "recipient", "subject", "outcome", "code",
        "http_status", "request_xml", "reply_xml", "problems", "sender",
    ]  # fmt: skip


def test_initialize_can_run_twice(store):
    store.add(new_message("A"))

    store.initialize()

    assert len(store.list_recent()) == 1


def test_adding_the_same_message_id_twice_returns_the_first_row(store):
    assert store.add(new_message("A", reply_xml="<first/>")) is None

    earlier = store.add(new_message("A", reply_xml="<second/>"))

    assert earlier is not None and earlier.reply_xml == "<first/>"
    assert len(store.list_recent()) == 1


def test_the_unique_index_is_what_refuses_the_second_insert(store):
    conn = sqlite3.connect(store._db_path)
    columns = "received_at, message_id, outcome, http_status, request_xml, reply_xml, problems"
    insert = f"INSERT INTO messages ({columns}) VALUES ('t', 'A', 'accepted', 200, '', '', '[]')"
    try:
        conn.execute(insert)
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(insert)
    finally:
        conn.close()


def test_rows_without_a_message_id_never_collide(store):
    for _ in range(3):
        assert (
            store.add(new_message(None, outcome="rejected", code="MALFORMED_XML", http_status=400))
            is None
        )

    assert len(store.list_recent()) == 3


def test_schema_invalid_rows_are_outside_the_unique_index(store):
    invalid = {"outcome": "rejected", "code": "SCHEMA_INVALID", "http_status": 422}

    assert store.add(new_message("A", **invalid)) is None
    assert store.add(new_message("A", **invalid)) is None  # the same id again: fine
    assert store.add(new_message("A")) is None  # and a valid one with that id: fine
    assert store.find_answered("A").outcome == "accepted"  # only the valid one counts


def test_the_table_refuses_a_code_that_does_not_match_the_outcome(store):
    with pytest.raises(sqlite3.IntegrityError):
        store.add(new_message("A", outcome="accepted", code="SCHEMA_INVALID"))
    with pytest.raises(sqlite3.IntegrityError):
        store.add(new_message("B", outcome="rejected", code=None))
    with pytest.raises(sqlite3.IntegrityError):
        store.add(new_message(None, outcome="rejected", code=None))


def test_findings_survive_the_round_trip(store):
    findings = [Finding(3, "first"), Finding(None, 'second "quoted" <b>')]
    store.add(new_message("A", problems=findings))

    assert store.find_answered("A").problems == findings


def test_sender_survives_the_round_trip_and_none_is_allowed(store):
    store.add(new_message("A", sender="requester@example.com"))
    store.add(new_message("B", sender=None))

    assert store.find_answered("A").sender == "requester@example.com"
    assert store.find_answered("B").sender is None


def test_the_newest_100_come_first(store):
    for n in range(105):
        store.add(new_message(ulid(n)))

    rows = store.list_recent(100)

    assert len(rows) == 100
    assert rows[0].message_id == ulid(104)
    assert rows[-1].message_id == ulid(5)


def test_get_returns_none_for_unknown_and_impossible_ids(store):
    assert store.get(1) is None
    assert store.get(0) is None
    assert store.get(2**70) is None  # SQLite cannot even bind this number


# --- Idempotency at the service level, with the lost race made deterministic -------------------


@pytest.fixture
def service(store) -> SubmissionService:
    return SubmissionService(
        store,
        SchemaValidator(SCHEMA_DIR / "submission.xsd"),
        SchemaValidator(SCHEMA_DIR / "reply.xsd"),
    )


class StoreThatNeverFindsAnEarlierAnswer:
    """Lets a request 'miss' the answer stored a moment ago, as in a real race: both requests
    look, both find nothing, both try to store."""

    def __init__(self, real: MessageStore) -> None:
        self._real = real

    def find_answered(self, message_id: str):
        return None

    def add(self, message: NewMessage):
        return self._real.add(message)


def test_a_lost_race_repeats_the_winners_answer(store):
    service = SubmissionService(
        StoreThatNeverFindsAnEarlierAnswer(store),
        SchemaValidator(SCHEMA_DIR / "submission.xsd"),
        SchemaValidator(SCHEMA_DIR / "reply.xsd"),
    )

    first = service.handle(make_submission(subject="Winner"))
    second = service.handle(make_submission(subject="Loser"))

    # Only the unique index could stop the second insert, and the answer repeated is the first.
    assert second.status_code == first.status_code == 200
    assert second.reply_xml == first.reply_xml
    assert [row.subject for row in store.list_recent()] == ["Winner"]


def test_many_parallel_requests_with_one_message_id_are_answered_once(service, store):
    workers = 16
    start_together = threading.Barrier(workers)

    def send(n: int):
        start_together.wait()
        return service.handle(make_submission(subject=f"Attempt {n}"))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        answers = list(pool.map(send, range(workers)))

    assert len({answer.reply_xml for answer in answers}) == 1  # everyone got the same reply
    assert len(store.list_recent()) == 1


# --- Restart ----------------------------------------------------------------------------------


def test_messages_and_idempotency_survive_a_restart(make_client, settings):

    before_restart = make_client()
    body = make_submission()
    headers = {"X-API-Key": API_KEY, "Content-Type": "application/xml"}
    first = before_restart.post("/v1/submissions", content=body, headers=headers)

    after_restart = make_client()  # a new application object on the same database file

    inbox = after_restart.get("/", auth=UI_AUTH)
    again = after_restart.post("/v1/submissions", content=body, headers=headers)
    assert "Delivery schedule" in inbox.text  # the subject of make_submission(), still on screen
    assert again.content == first.content
    assert len(all_rows(settings.db_path)) == 1
