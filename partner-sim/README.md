# Partner simulator

A small, independent application that plays the **recipient** of the messages the main system
sends. It accepts them over HTTP exactly as `contracts/partner-api.md` describes, validates them
against the XSD in `contracts/xsd/`, answers with a `Reply` document, and shows what arrived in a
web inbox, so that a person can *see* the messages.

It is **not** part of the AWS stack. It runs wherever Docker runs (a laptop, another cloud,
behind a tunnel) and shares only `contracts/` with the rest of the repository: it never imports
from `backend/`, `frontend/` or `infra/`.

> **A demo and a simulator, not a production service.** See [Limits](#limits) for what it does
> not do. The demo API key and password in `docker-compose.yml` are public: change them before
> anyone but you can reach the service.

## Quick start

```sh
cd partner-sim
docker compose up --build
```

Then open <http://127.0.0.1:8080/> and log in with the demo login below. Stop it with
`Ctrl+C`; `docker compose down` removes the container and keeps the stored messages,
`docker compose down -v` removes the messages too.

| | Demo value (in `docker-compose.yml`, public) |
|---|---|
| API key (`X-API-Key`) | `demo-key-change-me` |
| Inbox login | user `demo`, password `demo-password-change-me` |
| Address | `http://127.0.0.1:8080` (this computer only) |

To change any of them, copy `.env.example` to `.env` and edit it (see
[Configuration](#configuration)). Port 8080 taken? Set `PARTNER_PORT` in `.env`.

## What is where

| URL | What | Login |
|---|---|---|
| `POST /v1/submissions` | deliver a message (the partner API) | `X-API-Key` header |
| `GET /healthz` | `{"status":"ok"}` | none |
| `GET /` | the inbox: the newest 100 messages, refreshed every 5 seconds | HTTP Basic |
| `GET /messages/{id}` | one message: received XML, reply XML, validation findings, times | HTTP Basic |
| `GET /docs` | interactive API page (send a message by hand with *Try it out*) | none |
| `GET /openapi.json` | the OpenAPI description | none |

`/docs` loads its scripts from a public CDN (that is how FastAPI ships it), so the page needs
internet access in the browser. The API itself does not.

## Sending messages

Run these from the **repository root**. They use the real fixtures from `contracts/fixtures/`.

```sh
KEY=demo-key-change-me
URL=http://127.0.0.1:8080/v1/submissions
FIX=contracts/fixtures/submission
send() { curl -s -i -X POST "$URL" -H "X-API-Key: $KEY" -H 'Content-Type: application/xml' --data-binary @"$1"; }
```

| Outcome | Command | You get |
|---|---|---|
| Accepted | `send $FIX/valid/minimal.xml` | `200`, `Reply` with `Accepted` |
| The same message again | `send $FIX/valid/minimal.xml` | `200`, the identical stored answer (same `Reply/MessageId`); no second row in the inbox |
| Violates the schema | `send $FIX/invalid/subject-empty.xml` | `422`, `Rejected`, `SCHEMA_INVALID`, `Description` names the first problem |
| Not well-formed | `send $FIX/invalid/not-well-formed.xml` | `400`, `Rejected`, `MALFORMED_XML` |
| DOCTYPE with an external entity | `send $FIX/invalid/doctype-external-entity.xml` | `400`, `MALFORMED_XML`; nothing of `/etc/passwd` anywhere |
| DOCTYPE with entity expansion | `send $FIX/invalid/doctype-entity-expansion.xml` | `400`, `MALFORMED_XML`, at once |
| Refused by the recipient | `sed -e 's/Delivery schedule/[reject] demo/' -e 's/731S/7REJ/' $FIX/valid/minimal.xml \| send -` | `422`, `Rejected`, `RECIPIENT_REJECTED` |
| Temporarily unavailable | `sed -e 's/Delivery schedule/[fail] demo/' -e 's/731S/7FAJ/' $FIX/valid/minimal.xml \| send -` | `503`, `Retry-After: 1`, no body, **not stored** |
| Wrong or missing key | `curl -i -X POST $URL -H 'Content-Type: application/xml' --data-binary @$FIX/valid/minimal.xml` | `401`, no body |
| Wrong content type | `curl -i -X POST $URL -H "X-API-Key: $KEY" -H 'Content-Type: text/plain' --data-binary @$FIX/valid/minimal.xml` | `415`, no body |
| Too large (over 65 536 bytes) | `head -c 70000 /dev/zero \| curl -i -X POST $URL -H "X-API-Key: $KEY" -H 'Content-Type: application/xml' --data-binary @-` | `413`, no body |

Two things to know when you try the fixtures:

- **Every fixture carries the same `MessageId`.** The recipient answers a `MessageId` only
  once, so after `valid/minimal.xml` was accepted, another *valid* fixture is answered with the
  stored answer of the first (that is idempotency working). Schema-invalid and malformed messages
  are answered every time. `docker compose down -v` gives you an empty inbox. The `sed` commands
  above change the id for that reason (`I`, `L`, `O` and `U` are not allowed in a ULID).
- A `[reject]` or `[fail]` in the **Subject** triggers the rules of step 5 of the contract. In
  any other place, or in other letter case (`[REJECT]`), it does nothing.

## Where the data is and how to look at it

**The data** is one SQLite file: `/data/partner.db` inside the container. `/data` is the Docker
volume `partner-sim_partner-data` (Compose calls it `<project>_<volume>`; `docker volume ls`
shows it), so the messages survive `docker compose down`, a restart and a rebuilt image. While
the service runs, SQLite keeps two more files next to it, `partner.db-wal` and `partner.db-shm`
(WAL mode: a new write goes to the `-wal` file first and is merged into `partner.db` later).
Docker manages the volume's files itself (on Docker Desktop they are inside its virtual
machine), so use the commands below instead of looking for the file on your disk.

**The schema** is not hidden in Python: it is the numbered SQL files in `app/migrations/`
(`0001_initial.sql` holds the `messages` table and its unique index, with comments on why).
Read them in order and you have the schema. The database remembers how far it got in SQLite's
own `PRAGMA user_version` (a number in the file's header, no extra table). At start-up the
service applies every file that is newer than that number, each in one transaction together
with the new version: a file that fails leaves no trace, the service refuses to start and says
which file and why. A database that is *newer* than the code (a newer release migrated it) is
refused as well, with a message to upgrade the application.

**To change the schema**, add the next file (`0002_add_something.sql`: four digits, a lower-case
name) with plain SQL, and no `BEGIN` / `COMMIT` in it. Rebuild; every existing database gets it
once, at its next start. Never edit a file that has already been applied anywhere: databases
that ran it will not run it again, so they would differ from a new one. (Only `0001` is written
to be run twice, so that databases created before migrations existed are adopted; later files
need not be.) The files must be numbered 1, 2, 3, ... with no gap and no repeat, or the service
does not start. The files travel in the image with the rest of `app/`.

**Looking inside** (run from this folder, with the service up):

```sh
# The schema version, the tables with their row counts, the migrations still pending.
# Read-only: it opens the file with mode=ro and never applies anything.
docker compose exec partner-sim python -m app.migrate /data/partner.db
```

```
database: /data/partner.db
schema version: 1 (this application knows up to 1)
table messages: 3 rows
pending migrations: none
```

- **The inbox** (`http://127.0.0.1:8080/`, login above) lists the messages; a click shows the
  received XML, the reply and the findings.
- **A copy on your computer** (needs the `sqlite3` program on your computer; the image has none,
  only Python's `sqlite3` module):

  ```sh
  docker compose cp partner-sim:/data/partner.db ./partner.db
  sqlite3 partner.db "SELECT id, outcome, code FROM messages ORDER BY id DESC LIMIT 5"
  ```

  Careful: this copies `partner.db` **without** `partner.db-wal`. While the service is running,
  the newest writes can still be in the `-wal` file, and a copy without it does not have them
  (in an experiment, a committed row was missing from such a copy). For a consistent copy let
  SQLite make it, with its backup function, then copy that file out and remove it from the
  volume:

  ```sh
  docker compose exec partner-sim python -c "import sqlite3; s=sqlite3.connect('/data/partner.db'); d=sqlite3.connect('/data/backup.db'); s.backup(d); d.close()"
  docker compose cp partner-sim:/data/backup.db ./backup.db
  docker compose exec partner-sim rm /data/backup.db
  ```

  `*.db` is in `.gitignore`, so a copy in this folder cannot be committed by accident. It holds
  the message XML, so treat it like the messages themselves.
- **Start over**: `docker compose down -v` removes the volume, and with it every message and
  the database. The next start creates a fresh file and applies all the migrations.

## Tests

The tests run in the same image, with the shared fixtures mounted read-only from `contracts/`:

```sh
cd partner-sim
docker compose --profile tests run --rm --build tests
```

It walks every entry of `contracts/fixtures/expected.json` (submissions through the API,
replies against `reply.xsd`), checks the reply of every path against `reply.xsd` and against
the rule that `Code` and `Description` exist exactly when the status is `Rejected`, and covers
the failure paths: keys, content types, both size checks, idempotency (also with parallel
requests), `[reject]` and `[fail]`, hostile XML, the login, HTML escaping, restart and
start-up failures, and the migrations (an old database is adopted, a failing migration is
rolled back completely, a database newer than the code is refused). Lint: `docker compose --profile tests run --rm tests ruff check .`.

Without Docker (for quick iteration; a virtual environment with `requirements-dev.txt`):

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest          # finds the schemas and fixtures in ../contracts
```

## Optional: a public address through ngrok

> **Checked by hand with a free ngrok account:** the tunnel comes up, a public `POST` reaches the
> service (`200`), a wrong key gets `401`, and the inbox refuses the demo password. It ran with an
> address that ngrok assigned at random: without `--url` a free account gets a new one on every
> start. **Not checked yet:** the `tunnel` profile with the account's fixed dev domain in
> `NGROK_DOMAIN` (the address of your account is shown in the dashboard under *Domains*).

For a sender that cannot reach your computer (for example the main system on AWS), the `tunnel`
profile starts an ngrok container next to the service:

1. In `.env` set `NGROK_AUTHTOKEN` (from the ngrok dashboard) and `NGROK_DOMAIN` (the domain
   ngrok gave your account, e.g. `something.ngrok-free.app`, without `https://`).
2. **Change `PARTNER_API_KEY` and `UI_PASSWORD` in `.env`.** Through the tunnel the whole service,
   inbox login included, is on the internet, and the demo values are public.
3. `docker compose --profile tunnel up --build`
4. The sender's base URL is `https://<NGROK_DOMAIN>`. Traffic is also shown at
   <http://127.0.0.1:4040>.

The container runs `ngrok http partner-sim:8080 --url https://<NGROK_DOMAIN>`, with the token
in the environment (as the ngrok Docker documentation describes). ngrok ends TLS; the simulator
itself speaks plain HTTP.

## Configuration

Environment variables, checked at start-up. A wrong or missing value stops the application with
one message that lists every problem.

| Variable | Default | |
|---|---|---|
| `PARTNER_API_KEY` | none, **required** | The key senders put in `X-API-Key`. No default in the image. |
| `UI_USER` | none, required unless `UI_ENABLED=false` | Login of the inbox. |
| `UI_PASSWORD` | none, required unless `UI_ENABLED=false` | Password of the inbox. |
| `UI_ENABLED` | `true` | `false` turns the two pages off: only the API, `/docs` and `/healthz` remain. |
| `DB_PATH` | `/data/partner.db` | The SQLite file (the image keeps `/data` on a volume). |
| `SCHEMA_DIR` | `/app/schemas` | Folder with `submission.xsd`, `reply.xsd`, `common-types.xsd`. The image holds its own copy, taken from `contracts/xsd/` at build time. |
| `MAX_BODY_BYTES` | `65536` | Largest accepted request body. |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` or `CRITICAL`. |

Only for Compose: `PARTNER_PORT` (host port, default `8080`), `PARTNER_BIND` (default
`127.0.0.1`, this computer only; `0.0.0.0` serves other computers), `NGROK_AUTHTOKEN`,
`NGROK_DOMAIN`.

Nothing that comes from a message, and no key or password, is ever written to the log: only the
outcome of each request ("submission answered: status 422, SCHEMA_INVALID").

## How it is built

```
app/
  main.py        wiring; the uvicorn entry point; start-up errors end the process with one message
  config.py      environment -> Settings, validated
  api.py         HTTP layer of POST /v1/submissions (key, content type, size) and /healthz
  service.py     what happens to a submission (parse, validate, duplicate, own rules, accept)
  xml_input.py   the hardened parser, the DOCTYPE ban, reading fields, pretty printing
  validation.py  the XSD, loaded once, shared by threads behind a lock
  replies.py     building the Reply document; the Code/Description rule
  storage.py     SQLite: reading and writing the `messages` table
  migrate.py     applies the numbered SQL files at start-up; `python -m app.migrate <db>` looks inside
  migrations/    the database schema: 0001_initial.sql, 0002_..., applied in order
  ui.py          the two pages, login, security headers
  templates/     Jinja2 templates (autoescape on), inline CSS, no JavaScript
  security.py    constant-time comparison        timeutil.py  UTC timestamps
  models.py      plain data types shared by the layers
tests/           pytest
Dockerfile       stages: base -> test, base -> runtime (the last one, so the default)
```

Layers: `api.py` and `ui.py` speak HTTP and know nothing about XML; `service.py` knows the rules
and nothing about HTTP; `storage.py`, `xml_input.py`, `validation.py`, `replies.py` are small
tools it uses. The order of the steps is written at the top of `service.py`.

## Decisions

Each with the alternative that was rejected.

- **One lock around each XSD validation** (`validation.py`). An lxml `XMLSchema` keeps the error
  log of its latest run on the object, so two threads validating together can read each other's
  findings. *Rejected:* one schema object per thread (more code, more memory; a document of
  64 KiB validates in well under a millisecond, so the lock costs nothing that matters).
- **A new XML parser for every document.** No parser is ever shared between threads, so there
  is nothing to lock. *Rejected:* one shared parser (lxml serialises access to it anyway).
- **A SQLite connection per operation**, WAL mode. No connection is shared between the request
  threads. *Rejected:* one shared connection with a lock (state to reason about) and an ORM
  (not allowed, and not needed for one table).
- **Idempotency by a unique index**, not only by "look first, then insert". A lookup alone
  loses when two identical requests arrive together; the index lets exactly one insert through
  and the other request repeats the winner's answer. *Rejected:* an application-level lock.
- **The unique index leaves out `SCHEMA_INVALID` rows.** The contract validates (step 3) before
  it looks for duplicates (step 4), and an invalid document may not carry a real `MessageId`
  at all. So invalid documents are answered every time and never block a corrected one. Their
  id is still stored, for the inbox. *Rejected:* a plain unique index on `message_id`.
- **The schema is numbered SQL files, and the version is SQLite's `PRAGMA user_version`**
  (`app/migrations/`, `migrate.py`, standard library only). The SQL can be
  read without running anything, and the version is one integer in the file header, so there is
  no bookkeeping table to create first and keep in step. *Rejected:* a `schema_migrations` table
  (it would record when each file ran, which the integer cannot; the start-up log says it
  instead), Alembic or similar (a dependency and its own configuration for one table), and
  `CREATE TABLE IF NOT EXISTS` at every start, which is what it was before: it cannot change an
  existing table, and nothing says which version a database is at.
- **Each migration runs in one transaction together with its version update**, as one
  `BEGIN IMMEDIATE; <file>; PRAGMA user_version = N; COMMIT;` script that is rolled back on any
  error. SQLite can roll back `CREATE`/`ALTER`/`DROP` and the version change like any INSERT.
  *Rejected:* Python's own transaction handling (`executescript` commits first, and the implicit
  `BEGIN` covers only INSERT/UPDATE/DELETE, so a failing file would leave half of itself behind)
  and cutting the file into statements in Python. `PRAGMA journal_mode=WAL` stays outside
  (SQLite refuses it inside a transaction); it is a property of the file, set once.
- **`0001_initial.sql` is idempotent, later files are not.** A database made before migrations
  existed has the tables but version 0; running `0001` on it changes nothing except the version,
  which adopts it. *Rejected:* code that looks for the table and sets the version by hand (a
  special case that stays in the code for ever, where the idempotent SQL costs nothing).
- **A database newer than the code stops the start-up.** An older release must not write into a
  schema it does not know. There are no down-migrations: schemas only move forward (for a
  simulator, `docker compose down -v` is the way back).
- **Two DOCTYPE guards.** A search of the raw bytes for `<!DOCTYPE` (the parser never sees
  such a document), and a look at the parsed document (which catches what the byte search
  cannot, such as UTF-16). The byte search also refuses the same characters inside a comment or
  CDATA: an accepted false alarm ("any DOCTYPE at all"). *Rejected:* trusting the parser
  settings alone.
- **The reply is checked before it is sent** (`reply.xsd` and the Code/Description rule). Only a
  bug can make it fail, and then the answer is a loud 500, not a reply the sender must treat as
  a protocol violation. It also gives `reply.xsd` a job at run time.
- **Basic auth as a dependency of the whole UI router**, so a page added later is protected
  without anyone remembering to. *Rejected:* a login form and sessions (cookies, CSRF: more
  parts than a demo needs).
- **Refresh by `<meta http-equiv="refresh">`**, not JavaScript: the Content-Security-Policy
  forbids scripts, so there is nothing for a hostile message to run.
- **Plain `uvicorn`, one process.** Enough for a simulator. *Rejected:* gunicorn, `uvicorn[standard]`.
- **Every dependency pinned, also the transitive ones**, so an image built next year is the
  image built today.
- **`Dockerfile.dockerignore` as an allow-list.** The build context is the repository root
  (node_modules, `.git`, ...), so everything is excluded except what the Dockerfile copies (the
  context is about 40 kB). BuildKit reads this file next to the Dockerfile; the legacy builder
  would not, and `docker compose` uses BuildKit.
- **Tests are a stage of the same Dockerfile**, so pytest and ruff are not in the image that runs
  the service. *Rejected:* a second Dockerfile.
- **Demo values in the compose file, published on `127.0.0.1` only.** A stranger must be able to
  run it with one command; binding to this computer keeps the public demo password from being
  reachable by others. *Rejected:* required variables with no default (breaks the one command).

## Limits

- It **simulates**, it does not deliver anything. Messages are stored in one SQLite file, without
  a retention limit, until you remove the volume.
- One process, no rate limiting, no TLS of its own, no request timeout for slow uploads. Do not
  put it on the internet without the tunnel's TLS in front, and never with the demo values.
- Authentication is one shared API key and one shared inbox login. There are no client
  certificates (the contract allows them later).
- The two rules (`[reject]`, `[fail]`) are the only "business logic".
- Only x86-64 was built and run here.
