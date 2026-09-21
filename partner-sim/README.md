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
start-up failures. Lint: `docker compose --profile tests run --rm tests ruff check .`.

Without Docker (for quick iteration; a virtual environment with `requirements-dev.txt`):

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest          # finds the schemas and fixtures in ../contracts
```

## Optional: a public address through ngrok

> **Not verified end to end.** It needs an ngrok account, and I could not test it without one.
> What *was* checked: the image name and tag exist, its `http` command takes `host:port` and a
> `--url` flag, its entry script reads `NGROK_AUTHTOKEN`, and its web page listens on `0.0.0.0:4040`
> (all read from the image itself). What was *not*: a real tunnel, the exact domain format for a
> free account, and how ngrok's warning page for browsers looks.

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
  storage.py     SQLite: one table, one unique index
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
