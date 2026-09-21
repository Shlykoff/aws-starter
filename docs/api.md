# API and delivery contract

The single source of truth for backend, infrastructure and frontend. Change it here
first, then in the code.

Base URL: the `api_url` Terraform output. All routes need
`Authorization: Bearer <Cognito access token>`; the API Gateway JWT authorizer rejects
anything else with `401` before a Lambda runs. Bodies are JSON.

## Model

```
Request {
  id:        string   // ULID, time-sortable
  partner:   string   // 1-100 chars
  subject:   string   // 1-200 chars
  body:      string   // 1-5000 chars
  status:    "created" | "queued" | "sent" | "failed" | "rejected"
  createdAt: string   // ISO 8601, UTC
}
```

The owner (`sub` claim of the token) is stored with the item but never returned.

## Statuses

```
created --(enqueuer put it on the queue)--> queued --(partner answered 2xx)------> sent
   |                                           |--(partner answered 4xx)-------> rejected
   `-------- (the worker may see it first) ----`--(5th attempt failed, DLQ)-----> failed
```

- `created`: stored by the API. `queued`: on the SQS FIFO queue. `sent`: the partner
  accepted it. `rejected`: the partner refused it for good (retrying is pointless).
  `failed`: delivery attempts are exhausted and the message sits in the DLQ.
- `sent`, `rejected` and `failed` are **terminal**: they never change again.
- Every status change is a conditional `UpdateItem` (`ConditionExpression` on the current
  status), so a late or repeated message cannot move a request backwards.
  `queued` is set only from `created`; the terminal statuses only from `created` or `queued`
  (the worker can pick a message up before the enqueuer has written `queued`).
  A failed condition means somebody else already moved the request on: treat it as done,
  not as an error.

## Endpoints

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/requests` | `{ partner, subject, body }` | `201` `Request` (status `created`) | `400` validation, `500` |
| GET | `/requests` | | `200` `{ items: Request[] }`, newest first, at most 50 (pagination later) | `500` |
| GET | `/requests/{id}` | | `200` `Request` | `404` (also for a malformed id), `500` |
| GET | `/requests/{id}/exchange` | | `200` `Exchange` | `404` (no such request, or no delivery attempt yet), `500` |

`Exchange` is what the worker recorded about the **latest** delivery attempt (see "The exchange
record"). The XML in it is text for a person to read: clients must show it as text and never
interpret it as markup.

```
Exchange {
  attempt: number                 // which attempt this describes (1 = the first)
  at:      string                 // ISO 8601, UTC
  outcome: "delivered" | "refused" | "retry" | "invalid_request" | "unrepresentable"
  request: { xml: string, valid: boolean, problems: { element: string, rule: string }[] }
  //  ^ problems name the element and the rule, never the value found in it (it is personal data)
  reply:   null | { httpStatus: number, xml: string | null, valid: boolean,
                    status?: "Accepted" | "Rejected", code?: string, description?: string }
}
```

A request that belongs to another user is `404`, not `403`, so existence is not leaked.
A missing `sub` claim on a protected route is a misconfiguration and answers
`500 internal_error` (the reason is logged, the token is not). Reads are eventually
consistent: a list requested right after a create may briefly miss the new item, so
clients should use the `POST` response. The status changes after the response: clients that
show it poll every few seconds while a request is `created` or `queued`.

Errors produced by the Lambdas use one shape:

```
{ "error": { "code": "validation_error" | "not_found" | "internal_error",
             "message": string, "details"?: unknown } }
```

For `validation_error`, `details` is an array of `{ path: string, message: string }`
(`path` is the dotted JSON path of the invalid field). Errors produced by API Gateway
itself, such as a missing or invalid token, are `401` with `{ "message": "Unauthorized" }`:
a different shape.

CORS: allowed origins come from Terraform (`http://localhost:5173` and the site domain),
headers `authorization` and `content-type`, methods `GET`, `POST`, `OPTIONS`.

## Storage

Table `<project>-<env>-requests`, provisioned 5 RCU / 5 WCU, no autoscaling.
**DynamoDB Streams is on, view type `NEW_IMAGE`** (see "Delivery pipeline").

| Key | Attribute | Value |
|---|---|---|
| partition | `pk` (S) | `USER#<sub>` |
| sort | `sk` (S) | `REQ#<ULID>` |

Other attributes: `id`, `partner`, `subject`, `body`, `status`, `createdAt`.

- List = `Query` on `pk`, `ScanIndexForward=false`, `Limit=50`.
- Get = `GetItem` on (`pk`, `REQ#<id>`).
- `pk` is always built from the token's `sub`, never from client input, so one user cannot
  address another user's items. No GSI.
- Known limit: read capacity is charged by the size of the items read, not by the fields
  returned, so dropping `body` from the list response would not lower it. A page of 50
  items with maximum-size bodies (about 265 KB) costs roughly 33 RCU per call with
  eventually consistent reads, against 5 provisioned RCU. Burst capacity covers occasional
  calls; refreshing the list in a tight loop could throttle.

## Delivery pipeline

```
POST /requests -> DynamoDB (created) -> stream -> enqueuer -> SQS FIFO -> delivery-worker
                                                                 |          |-> build XML, check it against submission.xsd
                                                                 |          |-> HTTPS + API key -> the recipient (another system)
                                                                 |          |        <- XML reply, checked against reply.xsd
                                                                 |          |-> S3 exchange record, DynamoDB (sent | rejected | failed), SNS
                                                                 `-> after 5 receives -> DLQ (kept for inspection)
GET /requests/{id}/exchange -> the XML we sent and the XML that came back
```

**Outbox through DynamoDB Streams.** The API only writes to the table. The stream feeds the
`enqueuer`, so a request cannot be stored without also being queued (at least once), and the
API needs no permission for the queue.

**enqueuer** (event source mapping on the stream):
- Filter: `INSERT` events only, so the status updates of the pipeline do not trigger it again.
- Batch size up to 10 (`SendMessageBatch` takes at most 10). Reports failures per record
  (`ReportBatchItemFailures`), `bisect_batch_on_function_error`, a bounded number of retries
  and record age; when a record is given up on, the mapping's failure destination is the
  `alerts` SNS topic. Stream records live 24 h, so a stuck enqueuer must alert well before that.
- For each record it sends one message, then conditionally sets `queued` (from `created`).
  If the update fails the whole record is retried: the queue's deduplication and the worker's
  status check absorb the duplicate. Never log the record image (it holds the request text).

**Queue** `<project>-<env>-deliveries.fifo` and its DLQ `<project>-<env>-deliveries-dlq.fifo`
(a FIFO queue needs a FIFO DLQ):
- Message body: `{ "requestId": ULID, "ownerId": string }`. Ids only: no request text in the queue.
- `MessageGroupId` = SHA-256 hex of `partner.trim().toLowerCase()`. A hash, because a group id
  may only contain alphanumerics and punctuation and the partner is free text. Order is kept
  per partner; a failing message blocks its own partner's later messages until it is in the DLQ.
- `MessageDeduplicationId` = `requestId`. No content-based deduplication.
- Visibility timeout 120 s (at least 6 x the worker timeout), `maxReceiveCount` 5, retention
  4 days on the queue and 14 days on the DLQ, server-side encryption on.

**delivery-worker** (SQS event source mapping: batch size 1, `maximum_concurrency` 2,
`ReportBatchItemFailures`):
1. `GetItem` with `ConsistentRead` (the item was written moments ago). Terminal status:
   acknowledge and do nothing (idempotent consumer).
2. Build the `Submission` XML (`contracts/xsd/submission.xsd`) from the request: `MessageId` =
   the request id, `SentAt` = now (UTC), `Sender/Name` = the `SENDER_NAME` setting,
   `Recipient/Name` = the request's `partner`, `Subject` and `Text` from `subject` and `body`.
   Text is XML-escaped. A character that XML 1.0 cannot carry at all (most control characters)
   makes the request **unrepresentable**: it is `rejected` without calling anybody.
3. Check that XML against `submission.xsd` (the schema files are packaged with the function).
   A violation is `rejected` without calling anybody: the recipient would refuse it anyway, and
   retrying cannot change it. The problems are recorded as element and rule, never with the
   value. (The recipient's schema is stricter than the API: `partner` may be any text of 1-100
   characters when the request is created, but a name with `#` in it fails here.)
4. `POST` it to the recipient (`contracts/partner-api.md`) with an 8 s timeout and no redirects:
   `X-API-Key` (read from SSM Parameter Store, cached for 5 minutes), `Content-Type:
   application/xml`, `Idempotency-Key` = the request id, `User-Agent: aws-starter-worker/1`.
5. Read the answer the way `contracts/partner-api.md` ("How the sender reads the answer") says:
   `200` + `Accepted` = delivered; `400` or `422` + `Rejected` = `rejected`, no retry; `401`,
   `403`, `408`, `429`, any `5xx`, no answer or a timeout = retry; any other `4xx` = `rejected`
   (our request is wrong). The reply is untrusted input: at most 64 KiB, any DOCTYPE refused,
   checked against `reply.xsd` and against the rule that `Code` and `Description` exist exactly
   when the status is `Rejected`. A `200` whose body fails that check is a protocol violation by
   the recipient and counts as a temporary failure. So does anything the contract does not define
   (a redirect, a `1xx`, a `2xx` other than `200`) and a reply that contradicts its own status or
   names another `MessageId`: the cautious reading is to try again, never to guess (the table is
   in `contracts/partner-api.md`). 401 and 403 mean that our own credentials or
   permissions are wrong, not that the recipient refused the request, so they are retried and end
   as `failed` with an alarm, instead of a silent `rejected` that would hide a misconfiguration.
6. Write the exchange record to S3 (below), then the status: delivered = `sent`, refused =
   `rejected`, each followed by an SNS event. For a final outcome the record comes first: if the
   S3 write fails, the message is retried (the recipient deduplicates by `MessageId`) and no
   status is lost. For a temporary failure the record is diagnostics only: if it cannot be
   written, log that and carry on with the retry.
7. Retryable failure: report the message as failed so SQS retries it after the visibility timeout.
   On the **last** attempt (`ApproximateReceiveCount >= MAX_RECEIVE_COUNT`) set `failed` and
   publish first, then still report the message as failed so that SQS moves it to the DLQ,
   which keeps it for inspection. `MAX_RECEIVE_COUNT` comes from Terraform, the same value as
   the queue's `maxReceiveCount`.
8. The mapping uses batch size 1: a FIFO queue hands out the messages of one partner strictly
   in order, and with one message per invocation a failure affects only that message. The code
   also handles larger batches the way AWS advises for FIFO: stop at the first failure and
   return it and every message after it in `batchItemFailures` (keeps the order). The price
   of larger batches: the messages behind a failure are charged a receive without being tried,
   so they can reach the DLQ untried, and one failing partner holds back unrelated ones in the
   same batch. That is why the demo does not use them.
9. The SNS publish is best effort: log a failure, do not fail the message.
10. Two more outcomes that are reported as failed and end in the DLQ after the allowed receives:
   a malformed message body, and a message whose request does not exist (both are bugs, so
   they must be visible to the alarm, never silently acknowledged). If the conditional update
   finds the request already finished, the message is acknowledged: nothing to publish, no DLQ.

Known limits: if the worker dies between the partner's answer and the status update, the retry
sends a duplicate, so the partner must honour the `Idempotency-Key`. An unexpected error on our
side (DynamoDB, S3, a bug) never writes `failed`, even on the last attempt: the database may be
what broke, and after the partner accepted the request `failed` would be wrong. The message goes
to the DLQ, the alarm fires, and the request keeps its status. The same happens if the worker dies
on the last attempt before writing `failed`: the request stays `queued` and only the alarm shows it.

**The recipient** is another system: it may run in another cloud or behind a tunnel, and this
stack knows two things about it: a base URL (`PARTNER_URL`) and an API key (SSM Parameter Store,
SecureString, `/<env>/<project>/partner-api-key` (SSM refuses names that start with `aws` or `ssm`, so the
environment comes first); the function reads the parameter whose name is
in `PARTNER_API_KEY_PARAM`). Its contract is `contracts/partner-api.md`; the schemas and the
sample messages are in `contracts/`. Nothing here knows how it is built. The stand-in used for
demos and tests is `partner-sim/`, an independent application.

**The exchange record**: bucket `<project>-<env>-deliveries-<account id>` (private, encrypted,
objects expire after 30 days). One JSON object per request, key `exchanges/<requestId>.json`,
holding the `Exchange` of the endpoint above exactly as the endpoint returns it: the XML we
built (`request.xml`), and the body of the recipient's answer as received (`reply.xml`, `null`
when there was none). One object, so a reader never sees the request of one attempt next to the
reply of another. `outcome`: `delivered` (accepted), `refused` (the recipient said `Rejected`,
or another final 4xx), `retry` (a temporary failure), `invalid_request` (our XML failed
`submission.xsd`), `unrepresentable` (it could not even be built as XML; `request.xml` is then
`""`, there is nothing to show).
Each attempt overwrites the record, so it always describes the latest attempt. It holds the
request text: it is never logged, and only the owner of the request can read it (the endpoint
checks ownership in the table before it touches S3).

**SNS**
- `<project>-<env>-request-status`: the worker publishes one event per terminal status. Body
  `{ "requestId", "status", "at" }` (no request text), message attribute `status` (String). The
  owner's e-mail subscription has a filter policy on `status` in [`failed`, `rejected`].
- `<project>-<env>-alerts`: operational alarms and the enqueuer's failure destination. The
  owner's e-mail subscription has no filter. CloudWatch alarms: DLQ depth >= 1
  (`ApproximateNumberOfMessagesVisible`) and enqueuer `IteratorAge` above 5 minutes.
- The e-mail address is the `notification_email` Terraform variable (in CI a GitHub secret).
  Each subscription needs a confirmation click.

## Lambda contract

| Function | Trigger | DynamoDB | Other permissions (all resource-scoped) |
|---|---|---|---|
| `create-request` | `POST /requests` | `PutItem` | |
| `list-requests` | `GET /requests` | `Query` | |
| `get-request` | `GET /requests/{id}` | `GetItem` | |
| `enqueuer` | DynamoDB stream | `UpdateItem` | stream read; `sqs:SendMessage` on the queue; `sns:Publish` on `alerts` |
| `delivery-worker` | SQS queue | `GetItem`, `UpdateItem` | queue receive/delete/attributes; `sns:Publish` on `request-status`; `s3:PutObject` on `exchanges/*`; `ssm:GetParameter` on the API key parameter |
| `get-exchange` | `GET /requests/{id}/exchange` | `GetItem` | `s3:GetObject` on `exchanges/*`; `s3:ListBucket` on the bucket (without it S3 answers a missing key with 403 instead of 404; a prefix condition would not help, a GetObject request carries no prefix) |

- Runtime `nodejs24.x`, `arm64`, no VPC, handler `index.handler`, memory 256 MB. Timeouts:
  API functions and `enqueuer` 10 s, `delivery-worker` 15 s.
- The account allows only 10 concurrent Lambda executions, so no reserved concurrency; the two
  event source mappings that need it are capped (`maximum_concurrency` 2 on the queue).
- API events: HTTP API payload format 2.0 with JWT authorizer
  (`event.requestContext.authorizer.jwt.claims.sub`).
- Environment, all functions: `LOG_LEVEL` (default `info`), `NODE_OPTIONS=--enable-source-maps`
  (the build is minified; the source map keeps stack traces readable). Per function:
  API functions `TABLE_NAME`; `get-exchange` `TABLE_NAME`, `AUDIT_BUCKET`; `enqueuer`
  `TABLE_NAME`, `QUEUE_URL`; `delivery-worker` `TABLE_NAME`, `PARTNER_URL`,
  `PARTNER_API_KEY_PARAM`, `SENDER_NAME` (default `aws-starter`), `TOPIC_ARN` (request-status),
  `AUDIT_BUCKET`, `MAX_RECEIVE_COUNT`.
- The XSD files of `contracts/xsd/` are copied into the package of every function that needs
  them (`schemas/` next to `index.mjs`) by the build; the packaged copy is the sender's own copy
  of the contract.
- Build output: `backend/dist/<function>/index.mjs` (plus a source map). Terraform zips each
  directory with `archive_file`; the build does not produce zips.
