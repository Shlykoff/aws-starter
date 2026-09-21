"""Schema migrations for the SQLite file (standard library only: no Alembic, no ORM).

The schema lives in numbered SQL files in app/migrations/: 0001_initial.sql, 0002_..., and so
on. The version of a database is kept in SQLite's own `user_version` number (a small integer in
the database header, 0 in a new file). It is the number of the last file applied, so there is
no bookkeeping table to look after.

At start-up migrate() applies every file whose number is above the database's version, in
order. Each file runs in ONE transaction together with the version update: it is applied
completely, or not at all, and then the version stays where it was.

    python -m app.migrate /data/partner.db       look inside a database (read-only)
"""

import logging
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("partner_sim")

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
_FILE_NAME = re.compile(r"(\d{4})_[a-z0-9_]+\.sql")  # for example 0002_add_index.sql


class MigrationError(Exception):
    """The schema cannot be brought up to date. The text is meant for the person starting it."""


@dataclass(frozen=True)
class Migration:
    number: int
    path: Path


def find_migrations(directory: Path) -> list[Migration]:
    """The migration files in order. Their numbers must be 1, 2, 3, ... with no gap or repeat."""
    found = []
    for path in directory.glob("*.sql"):
        match = _FILE_NAME.fullmatch(path.name)
        if match is None:
            raise MigrationError(
                f"{path.name} is not a valid migration file name: use NNNN_name.sql, "
                f"for example 0001_initial.sql"
            )
        found.append(Migration(int(match.group(1)), path))
    if not found:
        # The most likely cause: the folder is missing from the Docker image.
        raise MigrationError(f"no migration files (*.sql) found in {directory}")

    found.sort(key=lambda migration: (migration.number, migration.path.name))
    for expected, migration in enumerate(found, start=1):
        if migration.number != expected:
            raise MigrationError(
                f"migration files must be numbered 1, 2, 3, ... without a gap or a duplicate: "
                f"expected {expected:04d}, found {migration.path.name}"
            )
    return found


def migrate(db_path: Path, migrations_dir: Path = MIGRATIONS_DIR) -> None:
    """Bring the database up to the newest schema version. Raises MigrationError.

    Assumes one process migrates at a time (the service runs a single uvicorn process). If two
    started together on an old database, the second would wait for the first and then fail
    loudly on a migration that is already applied; it would not damage anything.
    """
    migrations = find_migrations(migrations_dir)
    newest = migrations[-1].number

    # isolation_level=None: Python starts and ends no transactions behind our back, so the
    # BEGIN and COMMIT written in _apply() are the only ones. timeout: wait up to 5 s for a lock.
    conn = sqlite3.connect(db_path, timeout=5.0, isolation_level=None)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version > newest:
            # An old version of the code must never run against a newer schema.
            raise MigrationError(
                f"the database is at version {version}, this application knows up to {newest}: "
                f"upgrade the application, do not run an old version against a new database"
            )
        pending = [migration for migration in migrations if migration.number > version]
        for migration in pending:
            _apply(conn, migration)
            log.info("applied %s: schema version is now %d", migration.path.name, migration.number)
        if not pending:
            log.info("the schema is at version %d, nothing to apply", version)
    finally:
        conn.close()


def _apply(conn: sqlite3.Connection, migration: Migration) -> None:
    """Run one file and set the new version, in one transaction: all of it or none of it."""
    sql = migration.path.read_text(encoding="utf-8")
    # One script, so that it is one transaction. SQLite can roll back DDL (CREATE, ALTER, DROP)
    # and a change of user_version, just like INSERTs. BEGIN IMMEDIATE takes the write lock at
    # once instead of on the first write. The lone ";" ends the file's last statement in case its
    # author forgot to; without it the PRAGMA line would be glued to that statement.
    script = f"BEGIN IMMEDIATE;\n{sql}\n;\nPRAGMA user_version = {migration.number};\nCOMMIT;"
    try:
        # (executescript would COMMIT a transaction opened before it; here it is the first thing.)
        conn.executescript(script)
    except sqlite3.Error as exc:
        # An error stops the script but leaves the transaction open. Roll it back on purpose
        # (closing the connection would too, but then the rollback is invisible in the code).
        # Not always open: after some errors SQLite has rolled back by itself, and a ROLLBACK
        # with nothing to roll back would raise a second error that hides the first.
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise MigrationError(
            f"migration {migration.path.name} failed: {exc}. Nothing of it was kept: "
            f"the database is still at version {migration.number - 1}"
        ) from exc


def main(argv: list[str]) -> int:
    """`python -m app.migrate <db file>`: the schema version, the tables, the pending files.

    Read-only: the file is opened with mode=ro, and migrate() is never called.
    """
    if len(argv) != 2:
        print("usage: python -m app.migrate <path to the database file>", file=sys.stderr)
        return 2
    db_path = Path(argv[1])
    if not db_path.is_file():  # mode=ro alone would only say "unable to open database file"
        print(f"no database file at {db_path}", file=sys.stderr)
        return 1
    try:
        migrations = find_migrations(MIGRATIONS_DIR)
    except MigrationError as exc:
        print(exc, file=sys.stderr)
        return 1

    conn = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            " ORDER BY name"
        ).fetchall()
        print(f"database: {db_path}")
        print(f"schema version: {version} (this application knows up to {migrations[-1].number})")
        for (name,) in tables:
            # A table name cannot be a "?" parameter. These names come from the database itself.
            count = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
            print(f"table {name}: {count} rows")
    finally:
        conn.close()

    pending = [migration.path.name for migration in migrations if migration.number > version]
    print("pending migrations: " + (", ".join(pending) if pending else "none"))
    if version > migrations[-1].number:
        print("WARNING: this database is newer than the application, which will refuse to start")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
