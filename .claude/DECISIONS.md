# Decisions and limits

For whoever must defend a line: the owner in an interview, a reviewer, another agent. Written
down as decisions are made; each stage adds its own. Where a decision's mechanics are already
fully specified in `docs/api.md`, this file keeps only the "why this over the rejected
alternative" and points at the section by name instead of repeating it. `README.md` is the short
pitch for a stranger; this file and `docs/api.md` are where its claims are backed up.

## Decisions

- **Region `eu-north-1`.** Everything used here is available there and it is one
  of the cheaper regions.
- **Terraform state in S3 with native locking** (`use_lockfile`, Terraform >= 1.10),
  so there is no DynamoDB lock table to maintain. The bootstrap stack keeps its own
  state in the bucket it creates (one-time migration after the first apply). The bucket
  name is passed through a git-ignored `backend.tfbackend`, so the account ID is not
  committed.
- **GitHub Actions authenticates via OIDC**, not access keys. The trust policy is
  pinned to this repository's `main` branch, using GitHub's immutable subject claim (it
  carries the numeric owner and repository IDs, so a renamed or re-created repository
  does not inherit the trust).
- **Cost guard first**: an account-wide budget with e-mail alerts is created before
  any application resources.
- **DynamoDB in provisioned mode, small and fixed (5 RCU / 5 WCU, no autoscaling).**
  The load is tiny and predictable, and this stays inside the always-free limits.
  On-demand would be the choice for spiky or unknown traffic. Mechanics (table and GSI
  layout): `docs/api.md`, "Storage".
- **Request statuses separate temporary from permanent failures:** `failed` means delivery
  retries are exhausted (the owner can send it again); `rejected` means the message was
  refused for good and is not retried. Mechanics (the full state machine, conditional
  writes): `docs/api.md`, "Statuses".
- **REST API, not HTTP API.** It was an HTTP API first (cheaper, lower latency, a built-in
  JWT authorizer, no authorizer Lambda). It moved for the traces: a REST API can trace at the
  gateway (X-Ray on the stage, so API Gateway is a node of the trace) and continues a trace
  whose id the browser sends in `X-Amzn-Trace-Id`; an HTTP API cannot. A REST API also has a
  Cognito user-pool authorizer and per-method throttling built in. The higher price per request
  ($3.50 per million, against $1 for an HTTP API) does not matter at this volume. Rejected:
  staying on the HTTP API and using only the header from the browser (there would be no gateway
  node in the trace). Checked on AWS (Stage 12): the authorizer accepts the raw access token,
  API Gateway continues the browser's trace id, and the basic metrics appear with detailed
  metrics off. Mechanics this decision costs elsewhere (CORS built by hand, the payload-format-1.0
  event shape, the authorizer's exact checks, the gateway's 29 s timeout, the API's own metric
  names): `docs/api.md`, "Endpoints", "Lambda contract", "Limits at the gateway" and "Logs".
- **Cognito: Essentials tier with the classic hosted UI** instead of managed login. The
  classic UI covers login, logout and password reset, and managed login needs an extra
  branding resource before it renders anything.
- **Outbox through DynamoDB Streams**, not the API sending to SQS after the write (that
  leaves a gap when the send fails). Mechanics: `docs/api.md`, "Delivery pipeline".
- **SQS FIFO, `MessageGroupId` hashed from the partner name, batch size 1.** Rejected: larger
  batches — in a FIFO batch a failing message drags the messages behind it, other partners'
  included, into retries, and each retry is charged a receive, so they could reach the DLQ
  untried. Mechanics: `docs/api.md`, "Delivery pipeline" (Queue, and `delivery-worker` point 8).
- **The worker writes `failed` itself on the last attempt**, not a stuck message: a failure the
  owner can act on is a state of the request. Mechanics: `docs/api.md`, "Delivery pipeline"
  (`delivery-worker`, step 7).
- **The DLQ is a quarantine, not a pipe**: nothing reads it automatically, because a function
  reading it would delete exactly what the alarm is meant to show. Earlier a delivery that ran
  out of attempts went there too; with a Send again button that would have left a stale message
  and an alarm after every successful retry. What ends up there: `docs/api.md`, "Delivery
  pipeline" (`delivery-worker`, step 10) and "Inspecting and redriving the DLQ".
- **Sending a failed request again is a state change, not a message re-sent directly.**
  `POST /requests/{id}/retry` only flips the status with a conditional update, and the same
  outbox (stream -> enqueuer) that carries a new request carries it onward — the API still
  needs no queue permission. `rejected` cannot be sent again (the same message would get the
  same answer). Mechanics: `docs/api.md`, "Sending a failed request again" and "Delivery
  pipeline" (`enqueuer`).
- **A 401 or 403 from the partner is retried, not rejected**: it means our own credentials or
  permissions are wrong, so it ends as `failed` with an alarm instead of a silent `rejected`.
  Mechanics: `docs/api.md`, "Delivery pipeline" (`delivery-worker`, step 5).
- **The recipient is a separate system, not part of the AWS stack.** This stack knows its base
  URL and an API key, nothing else; the two sides share only `contracts/` (XSD, HTTP contract,
  sample messages) and each validates against its own copy. It could live in another cloud, so
  a mock inside this account would have shown nothing about the interface. The stand-in,
  `partner-sim/`, is a Python app (a different stack on purpose: a Node.js sender and a Python
  recipient show that the contract works, not the code). Rejected: a Lambda mock in this account.
- **The API key lives in SSM Parameter Store (SecureString), written with a write-only
  argument.** Terraform sends it to SSM and stores it neither in state nor in a plan file; the
  price is that a rotation needs a version bump (documented at the parameter). Rejected: Secrets
  Manager (billed per secret), an environment variable (visible in the console).
- **One S3 object per request holds the exchange record** (not one object per attempt), so a
  reader never sees the request of one attempt next to the reply of another. The reader needs
  `s3:ListBucket` too, or a missing key looks like an error (S3 answers 403, not 404, without
  it). Mechanics: `docs/api.md`, "The exchange record" and "Lambda contract" (`get-exchange`).
- **Alarms treat missing data as fine, and the SNS topics are not KMS-encrypted.** An idle
  queue publishes no metric, and encrypted topics can only receive CloudWatch alarms through a
  customer-managed key. The messages hold ids and alarm data, never request text.
- **XSD validation with libxml2 on both sides**: `xmllint-wasm` in the Node.js sender, `lxml` in
  the Python recipient. Both need full XSD 1.0 with `xs:import`, which the pure-JavaScript
  validators do not offer, and a native binary is a build problem on Lambda; WebAssembly is
  neither. The honest limit: both sides run the same engine, so the shared fixtures
  (`contracts/fixtures/expected.json`, run by both test suites) prove that the two
  implementations agree on the contract, not that two independent validators agree.
- **`xmllint-wasm` is not bundled.** It starts a worker thread from a script file and reads its
  `.wasm` next to itself, so inside one bundled `.mjs` it fails. The build leaves it out and copies
  the package next to the function (`dist/delivery-worker/node_modules`), together with the three
  schema files. Cost: about 70 ms per validation and a 6.9 MB unzipped package.
- **The validator's report never contains a value** (libxml2 quotes the offending value, which is
  personal data): it is turned into an element name and a rule from closed lists, in the
  findings and in the logs alike. Tests put a canary string into every field and check it never
  surfaces. Mechanics: `docs/api.md`, "Endpoints" (the `Exchange.request.problems` shape) and
  "Logs".
- **The recipient's answer is untrusted input**, treated with the same care as any external
  HTTP response: size-capped, DOCTYPE refused before parsing, redirects never followed (the API
  key must not travel to another host), and anything the contract does not define is retried
  rather than guessed at. Mechanics: `docs/api.md`, "Delivery pipeline" (`delivery-worker`,
  step 5).
- **A reply is read by a real XML parser (`@xmldom/xmldom`), after libxml2 has judged it valid.**
  A regular expression is wrong for valid documents (comments, CDATA, namespace prefixes).
  Rejected: `fast-xml-parser` (six dependencies of its own).
- **Idempotency across the two systems**: the `MessageId` of a message is the request id, so a
  retried delivery after a crash gets back the stored answer instead of delivering twice.
  Mechanics: `docs/api.md`, "Delivery pipeline" (`delivery-worker`, step 4) and "Known limits".
- **The client's decision is its own field, not a status.** Keeping them apart lets an event
  arrive before the worker has written `sent` (accepted anyway) and needs no timer or alarm — a
  payment can take days. Mechanics: `docs/api.md`, "Model" and "Client decision (webhook)".
- **The webhook is public, and the signature is the door** (no Cognito token — the caller is
  another system). The check runs in two steps: the shape of the headers and the age first, the
  token only after that, so junk from the internet cannot cost an SSM call; nothing else, no
  parsing and no database, happens before it is right. Rejected: a static token in a header (it
  travels, and a captured request could be replayed). Mechanics (the HMAC construction, the SSM
  location, throttling numbers): `docs/api.md`, "Client decision (webhook)".
- **Events are found by id and applied by one conditional write**, never a second read to tell
  "already applied" from "a real update" apart: `ALL_OLD` on a failed condition does that job.
  Mechanics: `docs/api.md`, "Client decision (webhook)" and "Storage" (index `by-request-id`).
- **The recipient's side of the action is a person, not a timer.** In `partner-sim` two buttons
  send the event, one attempt per click, and "Send again" repeats the same event, which is how
  the receiver's idempotency is seen.
- **A request has a timeline in the logs, typed events, not a separate audit table.** The table
  keeps only the current status, so a typed catalogue of `Request event` lines (a misspelled
  event, or a field of another event, does not compile) is the audit trail; the log guard checks
  it at run time too. Rejected: a separate audit table (a second write path to keep in step with
  the first) and the DynamoDB stream as the audit source (it has no actor and no attempt).
  Mechanics: `docs/api.md`, "Logs" ("Request events").
- **Logs are guarded by the logger, not only by care.** A field list with a shape for each value,
  checked at run time (and thrown on in tests), replaces the convention "no message text, names,
  reasons or tokens in a log" — the shape matters as much as the name (`reason` is a fixed word
  in the worker, free text in a webhook event). Rejected: a list of forbidden names (it fails the
  day somebody picks a new one) and CloudWatch's data protection policies (billed per GB
  scanned, so not free). Mechanics: `docs/api.md`, "Logs" ("Which fields").
- **Metrics are counted from the log lines, and there are few of them** (10 custom metrics and
  10 alarms are the free limits, and both are used up). The filters match on terms, not JSON,
  because Lambda's text log format puts `timestamp id LEVEL` before our JSON, and a JSON filter
  pattern does not match such a line (tried with `aws logs test-metric-filter`). Rejected: a
  metric per partner or per function as a dimension (the free metrics would be gone at once, and
  a partner name is not for a metric name), and a JSON log format (it would allow JSON patterns,
  but changes every line). Mechanics: `docs/api.md`, "Logs" ("Metrics, alarms, dashboard").
- **Old logs go to S3 through a small Lambda of ours, not through Firehose.** Firehose is the
  usual transport, but it has no free tier and the AWS free account plan this project runs on
  refuses it (`SubscriptionRequiredException`, found at the first deploy). Rejected: a scheduled
  export task (a batch job per day, hours of delay, one export at a time) and paying for
  Firehose. Mechanics: `docs/api.md`, "Log archive".
- **A request has one trace: AWS's layer records, our code carries the context.** The layer
  `AWSOpenTelemetryDistroJs` sends spans to the X-Ray OTLP endpoint with no collector to run;
  the DynamoDB stream and the HTTP webhook carry no trace on their own, so the code stores and
  passes a W3C `traceparent` by hand. Rejected: the X-Ray SDK (in maintenance mode since
  25 February 2026, security fixes only), the older ADOT layer (it asks for the handler to be
  exported with `module.exports`), Lambda's active tracing alone (seen on AWS: six unconnected
  traces), a collector layer or the CloudWatch agent (a second process in every function). The
  gateway was left out at first, because an HTTP API cannot trace; the REST API decision above
  put it in — that decision does not replace the code here: a REST API carries no trace over the
  stream or the queue, which is the part done in code. Left out, on purpose: the functions the
  browser polls (every 5 s, and every 30 s while a decision is awaited). Mechanics and the
  measured cold-start/memory cost: `docs/api.md`, "Traces".
- **The recipient runs on a free container host, not on a laptop.** A laptop that sleeps breaks
  deliveries and keeps the data on a personal machine. The image is built by a workflow, so what
  runs is what was tested, and the host only pulls it. Rejected: Render's free tier (no
  persistent disk, so the database is wiped at every redeploy, and it sleeps after 15 minutes
  without traffic, which needs a pinger); Fly.io, Railway and Koyeb (no longer a free tier that
  fits). Northflank's sandbox asks for a card and charges for the volume ($0.15 per GB per
  month, 6 GB minimum); that is the price of a database that survives a restart.
- **The DLQ redrive tool is a local script, not a Lambda, and it never acts on more than one
  message at a time.** A local script needs no new IAM role and costs nothing; it runs with the
  same admin profile `terraform apply` already does. Rejected: a bulk "redrive everything" flag
  — the DLQ mixes an outcome worth redriving (our own infra hiccup) with one that is never worth
  it (a malformed message, or the request is gone), and nothing in the message can tell the two
  apart automatically. It also keeps its own small copies of four pieces of `src/domain/` logic
  (a plain script run with `node` cannot import TypeScript without a bundler), held against the
  real functions by a test. Mechanics: `docs/api.md`, "Delivery pipeline" ("Inspecting and
  redriving the DLQ").

## Limits

- It shows an architecture; it is **not** a real e-prescription or NCPDP implementation. The
  message and its schemas are neutral and illustrative.
- Demo scale on purpose: DynamoDB 5/5 provisioned units, the account's Lambda concurrency of 10,
  one delivery at a time per partner name, the worker at most two at once.
- The recipient is a simulator with one shared API key and one inbox login, on the public internet
  around the clock, with no rate limit on its login. It runs on a free container host (a card for
  verification, $0.90 a month for the volume, an image that has to be redeployed by hand); while it
  is down, deliveries are retried and finally fail.
- The exchange record holds the message text (S3, SSE-S3, deleted after 30 days) and can be read
  only by the owner of the request. Logs are designed to carry no message text; a full review of
  them is still to do.
- Both validators are libxml2 (see Decisions).
- The log guard knows shapes, not meaning: a one-word value in a field that takes a word passes, and
  the text of an error is scrubbed of quotes and capped but not otherwise inspected. It covers the
  Lambdas. The recipient writes to its container's output, and its host terminates TLS and can see the
  traffic: fine for fake data, not for real data.
- Sending again has no limit on how often it is used, and only a `failed` request can be sent
  again. `backend/scripts/redrive-dlq.mjs` inspects and redrives the DLQ ("Decisions"), but the
  choice of redrive-or-discard per message is still the operator's, not automatic.
- The webhook is authenticated by a shared token, and rotating it is a manual step on both sides.
  Once the signature is right the recipient is trusted: an `OccurredAt` far in the future would keep
  the decision from ever being replaced.
- The API's Cognito authorizer does not check which app client a token was issued to: an app client
  added to this user pool later would be accepted too (there is one). CORS answers `*`, which is fine
  only while authorization stays a token in a header and never becomes a cookie. API Gateway's
  CloudWatch role is one per AWS account and region and this stack sets it: another stack in the same
  account and region that sets a different role would replace it.
- The page looks for a decision every 30 seconds while the tab is visible and the request is `sent`
  without one, and stops at the first decision; a later, changed decision shows after a reload.
