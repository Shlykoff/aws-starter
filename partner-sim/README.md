# Partner simulator

A small, independent application that plays the **recipient** of the messages the main system
sends. It accepts them over HTTP exactly as `contracts/partner-api.md` describes, validates them
against the XSD in `contracts/xsd/`, answers with a `Reply` document, and shows what arrived in a
web inbox, so that a person can *see* the messages. It also plays the **client**: after it accepted
a message, a person can press "Approve" or "Decline" on the message page, and the simulator calls
the sender's webhook with a signed `DecisionEvent` (see [Client action](#client-action-approve-and-decline)).

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
| `GET /messages/{id}` | one message: received XML, reply XML, validation findings, times; for an accepted one also the client action and its events | HTTP Basic |
| `POST /messages/{id}/decision` | the "Approve" / "Decline" buttons (form fields `decision`, `reason`); only with the webhook configured | HTTP Basic, same-origin only |
| `POST /messages/{id}/decision/{event}/resend` | the "Send again" button | HTTP Basic, same-origin only |
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

## Client action: Approve and Decline

The simulator plays the **client** as well. After it has accepted a message, the demo operator can
press **Approve** ("the client paid") or **Decline** ("out of stock", with an optional reason) on
the message page. The simulator then calls the **sender's** webhook with a signed XML
`DecisionEvent` ([`contracts/webhook-api.md`](../contracts/webhook-api.md),
[`contracts/xsd/event.xsd`](../contracts/xsd/event.xsd)). This can happen minutes or months after
the delivery, so there are **no timers, no delays and no deadlines**: it is a click, whenever.

**Switch it on** with two environment variables, both or neither (there is no screen for them):

| Variable | |
|---|---|
| `WEBHOOK_URL` | The sender's webhook: `<api_url>/webhooks/partner` of the AWS stack. `https://`, no `user:password@`, no `#fragment`. `http://` only for `localhost`, `127.0.0.1`, `[::1]` and `host.docker.internal` (a receiver on this computer). |
| `WEBHOOK_TOKEN` | The shared secret that signs the events: at least 16 characters and **the same value the sender holds** (its SSM parameter `webhook-token`, see `docs/api.md`). Never logged, stored or shown. Make one with `openssl rand -hex 32`. |

Put the values in the git-ignored `.env` (the token is a real secret), then `docker compose up -d`.
One variable without the other, a token that is too short or a bad URL stops the start-up with a message that says which.
Without them the message page says that the webhook is not configured and offers no action.

**Use it**

1. Deliver a message (see [Sending messages](#sending-messages)); it must be **accepted**. A
   rejected message gets no action.
2. Open it from the inbox. The section "Client action" has a reason field (optional, up to 500
   characters) and the buttons **Approve** and **Decline**.
3. Press one. The simulator builds the event, checks it against `event.xsd`, stores it, sends it
   **once**, and the page comes back with the outcome: `Sent: the sender answered 200`,
   `Not delivered: HTTP 401` or `Not delivered: no answer`.
4. The table below lists the events of the message: time, EventId, decision, reason, state,
   attempts, the HTTP status of the last attempt. **Send again** sends the *same* event again (same
   `EventId`, the same stored bytes) with a fresh timestamp and signature: this is how a
   redelivery, and the sender's idempotency, is shown. A new press of Approve or Decline is a
   **new** event (new `EventId`, new `OccurredAt`); the sender keeps the one with the latest
   `OccurredAt`, so a message can be approved and declined later.
5. The inbox has a column "Client": the newest decision, how many events there are, and
   "not delivered" when the newest one did not get through.

The state is the result of the **last** attempt: `delivered` for any `2xx`, `failed` for anything
else or no answer, `pending` for an event that is stored but was never sent (the process stopped
in between). What a failure means (from the contract): `401` = the token or the clocks are wrong,
fix that and press **Send again**; `429`, `5xx`, no answer = temporary, press **Send again**; any
other `4xx` = the event itself was refused.

**Against a sender on this computer** (for example a small script that verifies the signature):
`WEBHOOK_URL=http://host.docker.internal:9000/hook WEBHOOK_TOKEN=... docker compose up -d`.

**The request**: `POST` with `Content-Type: application/xml`, `User-Agent: partner-sim/1`,
`X-Webhook-Timestamp` (whole seconds) and `X-Webhook-Signature: v1=` + hex HMAC-SHA256 of
`<timestamp>.<body>` keyed with the token. Timeout 8 seconds, redirects are **not** followed (the
signature must not travel to another address). The tests reproduce the worked example in
`contracts/fixtures/event/signature-vector.json` byte for byte.

**The two buttons are POSTs behind HTTP Basic auth**, which a browser attaches to any request to
this address, also to one made by a form on another web site. So both refuse a request that does
not come from a page of this address (`403`): the `Origin` (or, without it, the `Referer`) must
name this host, and `Sec-Fetch-Site`, when present, must be `same-origin` or `none`. Behind a proxy
that changes the `Host` header, the buttons are refused too.

## Where the data is and how to look at it

**The data** is one SQLite file: `/data/partner.db` inside the container. `/data` is the Docker
volume `partner-sim_partner-data` (Compose calls it `<project>_<volume>`; `docker volume ls`
shows it), so the messages survive `docker compose down`, a restart and a rebuilt image. While
the service runs, SQLite keeps two more files next to it, `partner.db-wal` and `partner.db-shm`
(WAL mode: a new write goes to the `-wal` file first and is merged into `partner.db` later).
Docker manages the volume's files itself (on Docker Desktop they are inside its virtual
machine), so use the commands below instead of looking for the file on your disk.

**The schema** is not hidden in Python: it is the numbered SQL files in `app/migrations/`
(`0001_initial.sql` holds the `messages` table and its unique index, `0002_decision_events.sql` the
`decision_events` table of the [client action](#client-action-approve-and-decline), with comments
on why).
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
schema version: 2 (this application knows up to 2)
table decision_events: 2 rows
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
replies and decision events against their schemas), checks the reply of every path against `reply.xsd` and against
the rule that `Code` and `Description` exist exactly when the status is `Rejected`, and covers
the failure paths: keys, content types, both size checks, idempotency (also with parallel
requests), `[reject]` and `[fail]`, hostile XML, the login, HTML escaping, restart and
start-up failures, the client action (the signature against the worked example of the contract,
every `event` fixture, sending to a fake webhook on a local port: answers, timeouts, redirects,
"Send again", the cross-site refusals, secrets absent from the log), and the migrations (an old database is adopted, a failing migration is
rolled back completely, a database newer than the code is refused). Lint: `docker compose --profile tests run --rm tests ruff check .`.

Without Docker (for quick iteration; a virtual environment with `requirements-dev.txt`):

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest          # finds the schemas and fixtures in ../contracts
```

## Optional: a public address through ngrok

> **Checked with a free ngrok account** (the `tunnel` profile with the account's fixed dev domain in
> `NGROK_DOMAIN`): a public `POST` reaches the service (`200`), a wrong key gets `401`, and the
> inbox refuses the demo password. The main system on AWS delivered messages through it, and a
> stopped container showed up there as a `502` from ngrok (a temporary failure, retried). The
> address of your account is shown in the ngrok dashboard under *Domains*.

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

## The published image (for a hosting platform)

`.github/workflows/partner-sim-image.yml` tests the recipient and, on every push to `main` that
touches `partner-sim/` or `contracts/xsd/`, publishes it to the GitHub Container Registry as
`ghcr.io/<owner>/aws-starter-partner-sim` (`linux/amd64`), tagged `latest` and `sha-<commit>` (pin
the second when a deploy must be repeatable). A pull request only runs the tests.

To run it somewhere that is not your laptop:

- **The package has to be public** for a platform to pull it without credentials (GitHub: your
  profile, Packages, the package, Package settings, Change visibility). A new package starts private.
- **The image has no defaults for secrets.** It refuses to start without `PARTNER_API_KEY`, `UI_USER`
  and `UI_PASSWORD`; `WEBHOOK_URL` and `WEBHOOK_TOKEN` go together or not at all (see
  [Configuration](#configuration)). Set them in the platform's secret store, never in the repository.
- **It listens on port 8080** (HTTP; the platform terminates TLS) and answers `GET /healthz` for a
  health check.
- **The data is one SQLite file, `/data/partner.db`.** Mount a persistent volume at `/data`, and make
  sure the user inside the image (`app`) can write to it. Without a volume the messages, the client
  decisions and the memory of answered `MessageId`s disappear at every restart.

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
| `SCHEMA_DIR` | `/app/schemas` | Folder with `submission.xsd`, `reply.xsd`, `event.xsd`, `common-types.xsd`. The image holds its own copy, taken from `contracts/xsd/` at build time. |
| `WEBHOOK_URL` | empty (not configured) | The sender's webhook, for the [client action](#client-action-approve-and-decline). Both or neither with the token. |
| `WEBHOOK_TOKEN` | empty (not configured) | The shared token that signs the events, at least 16 characters. Never logged, stored or shown. |
| `MAX_BODY_BYTES` | `65536` | Largest accepted request body. |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` or `CRITICAL`. |

Only for Compose: `PARTNER_PORT` (host port, default `8080`), `PARTNER_BIND` (default
`127.0.0.1`, this computer only; `0.0.0.0` serves other computers), `NGROK_AUTHTOKEN`,
`NGROK_DOMAIN`.

Nothing that comes from a message, and no key, password, token or signature, is ever written to
the log: only the outcome of each request ("submission answered: status 422, SCHEMA_INVALID",
"decision event delivered: attempt 1, HTTP 200"). The reason a person types is not logged either.

## How it is built

```
app/
  main.py        wiring; the uvicorn entry point; start-up errors end the process with one message
  config.py      environment -> Settings, validated
  api.py         HTTP layer of POST /v1/submissions (key, content type, size) and /healthz
  service.py     what happens to a submission (parse, validate, duplicate, own rules, accept)
  decisions.py   what happens on Approve / Decline / Send again (build, store, send once, record)
  events.py      building the DecisionEvent and checking it against event.xsd; the reason's rules
  webhook.py     the signature and the one POST to the sender's webhook (httpx)
  xml_input.py   the hardened parser, the DOCTYPE ban, reading fields, pretty printing
  validation.py  the XSD, loaded once, shared by threads behind a lock
  replies.py     building the Reply document; the Code/Description rule
  storage.py     SQLite: reading and writing the `messages` and `decision_events` tables
  migrate.py     applies the numbered SQL files at start-up; `python -m app.migrate <db>` looks inside
  migrations/    the database schema: 0001_initial.sql, 0002_decision_events.sql, applied in order
  ui.py          the pages and the two client-action POSTs, login, security headers, cross-site guard
  templates/     Jinja2 templates (autoescape on), inline CSS, no JavaScript
  security.py    constant-time comparison        timeutil.py  UTC timestamps
  models.py      plain data types shared by the layers
tests/           pytest; fake_webhook.py is a small local server that plays the sender's webhook
Dockerfile       stages: base -> test, base -> runtime (the last one, so the default)
```

Layers: `api.py` and `ui.py` speak HTTP and know nothing about XML; `service.py` and `decisions.py`
know the rules and nothing about HTTP; `storage.py`, `xml_input.py`, `validation.py`, `replies.py`,
`events.py`, `webhook.py` are small tools they use. The order of the steps is written at the top of `service.py`.

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
- **The event is stored before it is sent, with its exact bytes** (`decisions.py`,
  `decision_events.event_xml`). A crash between the two cannot lose the decision (the row stays
  `pending`), and "Send again" sends the same bytes, so the sender sees the same `EventId`.
  *Rejected:* building the event again on a resend (a new `EventId` and `OccurredAt` would hide
  exactly what a redelivery is meant to show).
- **One attempt per click, no retry, no scheduler.** The client acts when a person clicks, and
  the contract has no deadline; the operator sees the outcome and can press "Send again".
  *Rejected:* a background retry loop (threads, timers and state for something a click does).
- **Our own event is validated against `event.xsd` before it is stored or sent**, and a failure
  logs only line numbers (the validator's messages quote the value, and the reason is typed
  text). Only a bug can make it fail; the same idea as the reply check. *Rejected:* trusting the
  builder.
- **The reason is checked before it reaches the XML**: at most 500 characters, and no character
  XML 1.0 cannot carry (checked before stripping, since `str.strip()` would silently remove some).
  *Rejected:* silently dropping such characters (the client's text would change unseen).
- **Both `WEBHOOK_*` variables or neither; the token must be 16+ characters and is not trimmed;
  `http://` only for loopback hosts** (`config.py`). A half configuration is a mistake, a space
  at the end of the token would make every event a `401`, and an event must not cross a network
  unencrypted. *Rejected:* a silent default, trimming, any `http://`.
- **`httpx`, a client per call, `follow_redirects=False`, `trust_env=False`, status line only.**
  Nothing is shared between threads, the signed request never goes to another address, proxy
  settings and `~/.netrc` of the environment are not consulted, and the empty answer body is not
  read. Moved from the test requirements to the runtime ones (same pin). *Rejected:* `urllib`
  (redirects and proxies are followed unless taken apart by hand).
- **The state of an event is the result of its last attempt.** *Rejected:* a state that stays
  `delivered` once it was (it would hide that the last "Send again" failed).
- **The cross-site guard checks `Origin`, then `Referer`, and `Sec-Fetch-Site`** (`ui.py`),
  because Basic auth is sent by the browser on any request. `Referrer-Policy` became
  `same-origin`: with `no-referrer` a browser sends `Origin: null` from our own form. *Rejected:*
  CSRF tokens (Basic auth has no session to keep one in) and turning the login into a cookie
  session (more parts than a demo needs).
- **The form is read with the standard library** (`urllib.parse.parse_qs`, 16 KiB limit).
  *Rejected:* `python-multipart`, which Starlette needs for any form: a new dependency for one
  small form.
- **After a POST the page is told which event to report, not what to say.** `303` to
  `/messages/1?event=<EventId>`; the page finds that event and writes the outcome line itself.
  *Rejected:* the sentence in the address (any link could then put words on the page) and a
  cookie.
- **SQLite foreign keys are switched on for every connection** (`storage.py`), so an event cannot
  point at a message that does not exist. *Rejected:* leaving `REFERENCES` as a comment.
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
- Authentication is one shared API key and one shared inbox login.
- The two rules (`[reject]`, `[fail]`) are the only "business logic".
- The client action sends **one attempt per click**: no automatic retry, no background work. An
  event is stored with its exact bytes; "Send again" repeats it. `OccurredAt` has millisecond
  precision, so two presses in the same millisecond, or a clock that steps back between two
  presses, could make the sender ignore the later one (it keeps the latest `OccurredAt`).
- The 8-second timeout applies to each phase of the call (connect, send, wait for the answer), not
  to the whole call, and a name lookup is not covered by it.
- The buttons need a browser that sends `Origin` or `Referer` (all current ones do).
- Only x86-64 was built and run here.
