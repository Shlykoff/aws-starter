"""Schema migrations: numbered SQL files, a version in PRAGMA user_version, one transaction each."""

import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from helpers import API_KEY, SCHEMA_DIR

from app.main import create_app_from_env
from app.migrate import MIGRATIONS_DIR, MigrationError, find_migrations, main, migrate
from app.models import NewMessage
from app.storage import MessageStore

NEWEST = len(find_migrations(MIGRATIONS_DIR))  # the schema version a fresh database ends at

# The schema exactly as the code created it BEFORE migrations existed (the old `_SCHEMA`).
# A database made with this text is what a person who ran the old version has on their volume.
OLD_SCHEMA = """
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


# --- Small helpers: look into a database without using the application's own code ----------------


def make_old_database(db_path: Path) -> None:
    """A database as the old code left it: the tables, one message, user_version still 0."""
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(OLD_SCHEMA)
        conn.execute(
            "INSERT INTO messages (received_at, message_id, outcome, http_status, request_xml,"
            " reply_xml, problems) VALUES ('t', 'OLD-ROW', 'accepted', 200, '<a/>', '<b/>', '[]')"
        )
        conn.commit()
    finally:
        conn.close()


def version_of(db_path: Path) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()


def tables_of(db_path: Path) -> list[str]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        return [name for (name,) in rows]
    finally:
        conn.close()


def schema_of(db_path: Path) -> list[tuple]:
    """Every table and index as SQLite stored it: (type, name, CREATE statement)."""
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        return rows.fetchall()
    finally:
        conn.close()


def message_ids_of(db_path: Path) -> list[str]:
    conn = sqlite3.connect(db_path)
    try:
        return [m for (m,) in conn.execute("SELECT message_id FROM messages ORDER BY id")]
    finally:
        conn.close()


def write_migrations(folder: Path, files: dict[str, str]) -> Path:
    """A migrations folder of our own, for tests that need broken or extra files."""
    folder.mkdir(parents=True, exist_ok=True)
    for name, sql in files.items():
        (folder / name).write_text(sql, encoding="utf-8")
    return folder


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "partner.db"


@pytest.fixture
def only_the_first_file(tmp_path: Path) -> Path:
    """A folder holding just the shipped 0001_initial.sql: what the schema was at version 1."""
    folder = tmp_path / "only-0001"
    folder.mkdir()
    shutil.copy(MIGRATIONS_DIR / "0001_initial.sql", folder)
    return folder


def new_message(message_id: str) -> NewMessage:
    return NewMessage(
        received_at="2026-09-21T10:11:12.000Z",
        message_id=message_id,
        recipient="r",
        subject="s",
        outcome="accepted",
        code=None,
        http_status=200,
        request_xml="<a/>",
        reply_xml="<b/>",
        problems=[],
    )


# --- The shipped folder --------------------------------------------------------------------------


def test_the_shipped_migrations_are_numbered_without_gaps():
    migrations = find_migrations(MIGRATIONS_DIR)  # raises if a number is missing or repeated

    assert [m.number for m in migrations] == list(range(1, len(migrations) + 1))
    assert migrations[0].path.name == "0001_initial.sql"


# --- A new database ------------------------------------------------------------------------------


def test_an_empty_database_is_brought_to_the_newest_version_and_works(db_path):
    store = MessageStore(db_path)

    store.initialize()

    assert version_of(db_path) == NEWEST
    assert store.add(new_message("A")) is None  # insert and read back through the application
    assert [row.message_id for row in store.list_recent()] == ["A"]
    assert store.find_answered("A") is not None


def test_the_first_migration_creates_exactly_the_schema_the_old_code_created(
    tmp_path, only_the_first_file
):
    old_db, new_db = tmp_path / "old.db", tmp_path / "new.db"
    make_old_database(old_db)

    migrate(new_db, only_the_first_file)

    assert schema_of(new_db) == schema_of(old_db)  # same tables, CHECKs and partial index


# --- An old database: the tables are there, the version is 0 ------------------------------------


def test_an_old_database_is_adopted_by_the_first_migration(db_path, only_the_first_file):
    make_old_database(db_path)
    schema_before = schema_of(db_path)
    assert version_of(db_path) == 0

    migrate(db_path, only_the_first_file)

    assert version_of(db_path) == 1
    assert message_ids_of(db_path) == ["OLD-ROW"]  # the data is untouched
    assert schema_of(db_path) == schema_before


def test_the_shipped_migrations_bring_an_old_database_to_the_newest_version(db_path):
    make_old_database(db_path)

    MessageStore(db_path).initialize()

    assert version_of(db_path) == NEWEST
    assert message_ids_of(db_path) == ["OLD-ROW"]


# --- An up-to-date database ----------------------------------------------------------------------


def test_a_migration_that_is_already_applied_is_not_run_again(db_path, tmp_path):
    # 0002 is not idempotent: a second run would fail with "table b already exists".
    folder = write_migrations(
        tmp_path / "m",
        {"0001_a.sql": "CREATE TABLE a (x);", "0002_b.sql": "CREATE TABLE b (x);"},
    )
    migrate(db_path, folder)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO a VALUES (42)")
    conn.commit()
    conn.close()

    migrate(db_path, folder)  # again, after a restart

    assert version_of(db_path) == 2
    assert tables_of(db_path) == ["a", "b"]
    conn = sqlite3.connect(db_path)
    try:
        assert conn.execute("SELECT x FROM a").fetchall() == [(42,)]
    finally:
        conn.close()


def test_only_the_missing_migrations_run_on_a_database_that_is_behind(db_path, tmp_path):
    folder = write_migrations(tmp_path / "m", {"0001_a.sql": "CREATE TABLE a (x);"})
    migrate(db_path, folder)
    write_migrations(folder, {"0002_b.sql": "CREATE TABLE b (x);"})  # the code got newer

    migrate(db_path, folder)

    assert version_of(db_path) == 2
    assert tables_of(db_path) == ["a", "b"]


# --- A database that is newer than the code ------------------------------------------------------


def test_a_database_newer_than_the_code_is_refused(db_path):
    store = MessageStore(db_path)
    store.initialize()
    store.add(new_message("A"))
    conn = sqlite3.connect(db_path)
    conn.execute(f"PRAGMA user_version = {NEWEST + 1}")  # as if a newer release had migrated it
    conn.close()

    with pytest.raises(MigrationError) as caught:
        store.initialize()

    message = str(caught.value)
    assert f"the database is at version {NEWEST + 1}" in message
    assert f"knows up to {NEWEST}" in message
    assert "upgrade the application" in message
    assert version_of(db_path) == NEWEST + 1  # and it was not touched
    assert message_ids_of(db_path) == ["A"]


def test_the_service_does_not_start_on_a_database_newer_than_the_code(monkeypatch, db_path):
    MessageStore(db_path).initialize()
    conn = sqlite3.connect(db_path)
    conn.execute(f"PRAGMA user_version = {NEWEST + 1}")
    conn.close()
    for name, value in {
        "PARTNER_API_KEY": API_KEY,
        "UI_USER": "u",
        "UI_PASSWORD": "p",
        "DB_PATH": str(db_path),
        "SCHEMA_DIR": str(SCHEMA_DIR),
    }.items():
        monkeypatch.setenv(name, value)

    with pytest.raises(SystemExit) as caught:
        create_app_from_env()

    assert "partner-sim cannot start" in str(caught.value)
    assert "upgrade the application" in str(caught.value)


# --- A migration that fails ----------------------------------------------------------------------


def test_a_failing_migration_leaves_the_database_at_the_previous_version(db_path, tmp_path):
    folder = write_migrations(
        tmp_path / "m",
        {
            "0001_a.sql": "CREATE TABLE a (x);",
            # The first statement is fine, the second one fails: the first must not survive.
            "0002_broken.sql": "CREATE TABLE b (x);\nINSERT INTO no_such_table VALUES (1);",
        },
    )

    with pytest.raises(MigrationError) as caught:
        migrate(db_path, folder)

    assert "0002_broken.sql" in str(caught.value)
    assert "no such table: no_such_table" in str(caught.value)
    assert "still at version 1" in str(caught.value)
    assert version_of(db_path) == 1  # 0001 was applied and stays; 0002 did not bump it
    assert tables_of(db_path) == ["a"]  # and the table of its first statement is gone

    # Nothing is stuck: with the file fixed, the next start applies it.
    write_migrations(folder, {"0002_broken.sql": "CREATE TABLE b (x);"})
    migrate(db_path, folder)
    assert version_of(db_path) == 2
    assert tables_of(db_path) == ["a", "b"]


def test_a_failing_first_migration_leaves_an_empty_database_at_version_0(db_path, tmp_path):
    folder = write_migrations(
        tmp_path / "m", {"0001_broken.sql": "CREATE TABLE a (x);\nNOT VALID SQL;"}
    )

    with pytest.raises(MigrationError, match="0001_broken.sql"):
        migrate(db_path, folder)

    assert version_of(db_path) == 0
    assert tables_of(db_path) == []


def test_a_file_whose_last_statement_has_no_semicolon_still_works(db_path, tmp_path):
    folder = write_migrations(tmp_path / "m", {"0001_a.sql": "CREATE TABLE a (x)  -- no ; here"})

    migrate(db_path, folder)

    assert version_of(db_path) == 1
    assert tables_of(db_path) == ["a"]


# --- A wrong folder fails loudly, before the database is touched ---------------------------------


@pytest.mark.parametrize(
    ("names", "message"),
    [
        (["0001_a.sql", "0003_c.sql"], "expected 0002, found 0003_c.sql"),  # a gap
        (["0001_a.sql", "0002_b.sql", "0002_c.sql"], "expected 0003, found 0002_c.sql"),  # twice
        (["0002_b.sql"], "expected 0001, found 0002_b.sql"),  # does not start at 1
        (["0001_a.sql", "notes.sql"], "use NNNN_name.sql"),  # not NNNN_name.sql
        (["1_a.sql"], "use NNNN_name.sql"),  # too few digits
        ([], "no migration files"),  # empty
    ],
)
def test_a_folder_with_wrong_file_numbers_is_refused(db_path, tmp_path, names, message):
    folder = write_migrations(tmp_path / "m", {name: "SELECT 1;" for name in names})

    with pytest.raises(MigrationError, match=message):
        migrate(db_path, folder)

    assert not db_path.exists()  # refused before even opening the database


def test_a_missing_migrations_folder_is_refused(db_path, tmp_path):
    with pytest.raises(MigrationError, match="no migration files"):
        migrate(db_path, tmp_path / "no-such-folder")


# --- Looking inside: python -m app.migrate <db> ------------------------------------------------


def test_the_inspection_command_shows_version_tables_and_pending_files(db_path, capsys):
    store = MessageStore(db_path)
    store.initialize()
    store.add(new_message("A"))
    store.add(new_message("B"))

    assert main(["migrations", str(db_path)]) == 0

    out = capsys.readouterr().out
    assert f"schema version: {NEWEST} (this application knows up to {NEWEST})" in out
    assert "table messages: 2 rows" in out
    assert "pending migrations: none" in out


def test_the_inspection_command_never_changes_the_database(db_path, capsys):
    make_old_database(db_path)  # version 0: the runner WOULD migrate this one at start-up
    before = db_path.read_bytes()

    assert main(["migrations", str(db_path)]) == 0

    out = capsys.readouterr().out
    assert "schema version: 0" in out
    assert "table messages: 1 rows" in out
    assert "pending migrations: 0001_initial.sql" in out
    assert db_path.read_bytes() == before  # not a byte changed
    assert version_of(db_path) == 0


def test_the_inspection_command_does_not_create_a_missing_database(db_path, capsys):
    assert main(["migrations", str(db_path)]) == 1

    assert "no database file" in capsys.readouterr().err
    assert not db_path.exists()


def test_the_inspection_command_runs_as_a_module(db_path):
    """`python -m app.migrate <db>` works when started as a module, the way the README says."""
    MessageStore(db_path).initialize()
    app_root = Path(__file__).resolve().parents[1]  # the folder that holds app/

    result = subprocess.run(
        [sys.executable, "-m", "app.migrate", str(db_path)],
        cwd=app_root,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "pending migrations: none" in result.stdout
