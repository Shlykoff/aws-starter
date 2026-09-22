# Status

Build log of the project, one entry per stage: what was built and, in detail, what was checked
and how (live AWS runs, exact numbers, what was found only by running it). This file is for
Claude Code to read as working context across sessions, not for a reader of the top-level
README: `README.md` stays a short pitch and a quickstart for a stranger, `NOTES.md` (git-ignored)
holds the owner's private interview notes, and this file is the detailed changelog. When a stage
finishes, add its entry here, not to README (`.claude/CLAUDE.md`, "How a stage runs").

- [x] Stage 0: bootstrap (state bucket, budget alert, GitHub OIDC role)
- [x] Stage 1: REST API (API Gateway, Lambda, DynamoDB), Cognito, React login + list/form, CI/CD
- [x] Stage 2: async delivery (stream outbox, SQS FIFO, worker, DLQ, SNS). Checked on AWS
  with three requests: delivered, refused and failing (five attempts, then `failed`; at that
  stage the message also went to the DLQ, which stage 5 changed).
- [x] Stage 3: the recipient as a separate system, XML + XSD validation on both sides, the
  exchange record and its panel in the UI, the API key in SSM. Checked on AWS with the recipient
  running in Docker (first on a laptop behind a tunnel, now on a free container host): a request delivered in about two
  seconds, one refused by the recipient, one refused by our own schema check without calling
  anybody, one retried five times until `failed` (8 minutes), and one that waited while the
  recipient was down and was delivered on the second attempt after it came back. The logs of
  those runs contain no message text.
- [x] Stage 4: the client's decision by webhook: the recipient calls a public, signed route
  when the client approves or declines, whenever that happens. Checked on AWS with the recipient
  in Docker: a call without a signature and one with a wrong signature get `401`; Approve stores
  the decision (a reason with `&`, `<` and Cyrillic arrives byte for byte through API Gateway);
  Send again changes nothing; a later Decline replaces it; the delivery status stays `sent`. The
  logs of those calls contain no reason text and no token. A second `terraform plan` after the
  deploy shows no changes.
- [x] Stage 5: send a failed request again (a button on the request page). Checked on AWS: with the
  recipient stopped a request went through five attempts to `failed` and the DLQ stayed empty;
  with the recipient back, Send again delivered it (`sent`, the exchange counts from attempt 1);
  pressing again, or on a delivered request, gets `409`; another user's or a malformed id gets
  `404`. A second `terraform plan` after the deploy shows no changes.
- [x] Stage 6: the logs are guarded by the logger (only listed fields, each with a shape; see
  `.claude/DECISIONS.md`). Checked: every log group was searched for the text of about twenty live test requests
  before the change (no hit); after the deploy, traffic through every function, error paths
  included (a broken JSON body and invalid fields carrying a marker string), left no marker string
  and no `[unlisted]` or `[rejected]` in 97 log lines, and the lines still carry ids, outcomes and
  counts.
- [x] Stage 7: the recipient off the laptop: its image is built and published by a workflow and runs on
  a free container host (Northflank sandbox, London) with a volume for its database. Checked: the
  image starts as published, its key and login work, a message survived a rollout restart, and the
  whole loop from AWS (delivery, Approve, Send again, Decline) ran against it.
- [x] Stage 8: request events in the logs: every real change in the life of a request writes one
  `Request event` line (created, queued, each delivery attempt with the recipient's answer and how
  long it took, sent, rejected, failed, retry requested, client decision recorded). Checked on AWS:
  one Logs Insights query over all the function log groups gives the timeline of a request (created,
  queued 1.2 s later, delivered with the recipient's answer in 385 ms, sent 5 s after creation, the
  two decisions); a repeated event produced no line; a retry produced `retry_requested` with the real
  `retryCount`.
- [x] Stage 9: metrics, alarms and a dashboard for the delivery: 8 custom metrics (six counted from the
  log lines, two durations written by the worker), 10 alarms, one dashboard and six saved Logs
  Insights queries, all inside the free tier. Checked on AWS: after a live delivery the two duration
  metrics held exactly the values of the log line (6837 ms until sent, 407 ms for the recipient's
  answer); six calls with a wrong signature moved the `webhook-unauthorized` alarm to ALARM within a
  minute and the notification mail arrived; all six saved queries run.
- [x] Stage 10: a long-term log archive: every log group is copied to S3 by a small Lambda within
  seconds, kept 13 months and queried with Athena. Checked on AWS: a live delivery loop produced 13
  objects (78 log events, 10 KB) from the six function log groups and the API access log, each one JSON
  line; the reason texts sent in that loop are nowhere in them; Athena returned the timeline of the
  test request (the same six events as Logs Insights). Found only by running it: Firehose is refused by
  the free account plan (replaced by the Lambda), and the saved queries did not run (fixed). Not seen
  yet: a request that failed after the archive started, so "failed requests per day" returned no rows.
- [x] Stage 11: one trace per request. Checked on AWS with one live loop (creation, delivery, three
  decision events): a single trace of 30 spans holds `create request`, `enqueue request` (from the
  enqueuer), `deliver request` (from the worker) with each of its calls and their times (DynamoDB, the
  XML checks about 0.5 and 0.7 s, SSM, the recipient 0.3 s, S3, SNS) and the three `record decision`
  spans (from the webhook); all six request events carry that trace's id. Not in it at that stage,
  on purpose: the browser and API Gateway (the API was an HTTP API then, which has no X-Ray
  integration, so the trace started in create-request; stage 12 changes that), the start-up (`Init`)
  of enqueuer, worker and webhook (it stays in the trace of the invocation), and the polled read
  functions. Three things were found only by running it and are in the history: the
  log group `aws/spans` cannot be created by us (AWS reserves the prefix), a worker thread of the XML
  validator started the tracing SDK again (fixed in the build), and Lambda links the consumer of a
  queue message to the trace instead of joining it (the worker takes the parent from the message).
- [x] Stage 12: the API is a REST API instead of an HTTP API, so that API Gateway is a node of the
  trace and the trace of a user action starts with an id made in the browser (see `.claude/DECISIONS.md`). Checked on
  AWS after the deploy (55 added, 8 changed, 21 destroyed: the old HTTP API): without a token the
  gateway answers 401 with the CORS header, and a preflight for `POST /requests` allows
  `X-Amzn-Trace-Id`; a signed decision event with Cyrillic and Chinese text went through the gateway and
  was stored byte for byte; the basic API metrics (`Count`, `4XXError`, `5XXError` by `ApiName` and
  `Stage`) appear with detailed metrics off. From a browser (sign-in, list, create, exchange, all with
  the raw access token, no `Bearer `): the access log shows 200 on the reads, 201 on the create and one
  404 (the exchange of a request that has not been tried yet: it answered 404 then, and answers 204
  since the fix that followed); one request made in the browser
  gave **one trace of 40 spans** that starts at the gateway (`POST /requests`), goes through
  `create-request`, `enqueue request` and both delivery attempts (the first got a 503 from the recipient,
  which was restarting, the second was delivered), and the gateway span has the parent id that the
  browser made, so API Gateway continued the browser's trace. The recipient's `WEBHOOK_URL` changed with
  the URL (it contains the stage).
- [x] Stage 13: three SLOs and a game day. SLOs (30-day rolling attainment, on the existing dashboard,
  no new alarm: the free 10 are spent) — API availability ≥ 99.5 %, delivery success ≥ 95 % (a
  partner's own refusal does not count against it), time to sent p95 ≤ 5 min; read live after the
  deploy: 100 %, 100 %, and a p95 of about 123 s. Game day (a QA agent, the public API and webhook
  only, never `partner-sim`, never a direct write to SQS or DynamoDB): a flood of six bad webhook
  signatures moved `webhook-unauthorized` to ALARM and it returned to OK on its own five minutes
  after the flood stopped (checked independently, not only in the agent's report); the order-of-checks
  matrix of the webhook contract (413, 401, 415, 400, 422, 404, a clock five minutes each way) matched
  exactly; a replayed and an out-of-order decision event both left the stored decision untouched; a
  storm of eight retries on a `sent` (not `failed`) request was refused all eight times, no phantom
  `retry_requested` line; five canary strings, the owner id and the webhook token were searched across
  every log group, `aws/spans` and the S3 log archive (not swept before) and found nowhere. No defect.
- [x] Stage 14: an operator CLI for the dead-letter queue,
  `backend/scripts/redrive-dlq.mjs` (`list`, `redrive <messageId>`, `discard <messageId>`), run
  locally with the owner's own AWS profile: no new Lambda, IAM role or Terraform resource. It
  duplicates four small pieces of `src/domain/` logic on purpose (it runs with plain `node`, no
  bundler, and the domain module is TypeScript), held against the real ones by a test so the two
  cannot drift apart silently. Checked live, with the owner's consent, by putting two messages into
  the real DLQ by hand: `list` showed the right requestId, partner, status and age for a real
  request, and "request not found" for one whose id does not exist; `redrive` sent the real one back
  to the delivery queue with a fresh deduplication id, deleted it from the DLQ, and the real worker
  (its own SQS event source mapping, not a direct invoke) picked it up seconds later and logged
  `"Request is already finished, skipping" status=sent` — the idempotent-consumer path, not a
  duplicate delivery, because the request had already reached `sent` through the ordinary
  pipeline; `discard` removed the message for the nonexistent request, and the DLQ was empty again
  afterwards, with no `dlq-not-empty` alarm noise (checked against `describe-alarms`: it never left
  OK, the test was shorter than its evaluation window). One finding along the way: back-to-back
  invocations can race the DLQ's 30 s visibility timeout (a `list` right before a `redrive` can hide
  the very message it just showed); the tool's own last line already says so, and the fix is simply
  to wait or retry, not a code change.

- [x] Stage 15: one fixed recipient instead of a per-request partner, and the requester's own
  identity in the message. `partner` is gone end to end (API body, domain, DynamoDB item, FIFO
  `MessageGroupId`, the frontend form and list); `Recipient/Name` in the XML is now the fixed
  constant `RECIPIENT_NAME`, and `Sender/Name` is the requester's own e-mail, read once from
  Cognito's `GetUser` (their own access token, a new unscoped `cognito-idp:GetUser` IAM
  permission — GetUser takes no pool ARN of its own) when the request is created and stored as
  `senderEmail`, never re-read. `contracts/xsd/common-types.xsd`'s `PartyName` widened to allow
  `@ _ +` (common e-mail local-part characters; the full RFC 5322 grammar is not covered — an
  address with a rarer character such as `!` still fails the recipient's schema and the request
  is `rejected`, covered by a test). partner-sim now parses and stores `Sender/Name` (it never
  did before) and its inbox shows the sender's e-mail, the date, the subject and the outcome —
  `MessageId`, `Recipient` and the raw HTTP status were dropped from both its pages (still parsed
  and stored, just not shown: the raw XML dumps on the message page still carry them). Checked:
  full `typecheck`/`lint`/`test` across backend (1499 passed) and frontend (285 passed), the
  partner-sim Docker suite (442 passed) after every contracts change, `terraform fmt`/`validate`,
  and a repo-wide grep for stale `partner`-field references (none left; generic prose like "the
  partner accepted the message" was deliberately left as is). Not yet checked live: creating a
  real request against the deployed API depends on a real Cognito login, which was not done in
  this session — the owner doing the existing "Try it" walkthrough once after this deploys would
  confirm the `GetUser` call and the sender e-mail showing up in partner-sim's inbox.

## Open

- Visual polish of the frontend (not started).
- No smoke test runs automatically after a deploy (not started).
- A second, from-scratch account has never run "Try it": the steps are only verified on the
  author's own account, through CI.
- Stage 15's live check (see above): the owner running "Try it" once after this deploys.
