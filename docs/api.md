# API and delivery contract

The single source of truth for backend, infrastructure and frontend. Change it here
first, then in the code.

The API is an API Gateway **REST API** (`infra/modules/rest-api`; why it is not an HTTP API is in
`.claude/DECISIONS.md`).

Base URL: the `api_url` Terraform output. It contains the **stage**, so it looks like
`https://<id>.execute-api.<region>.amazonaws.com/v1`, and a path is appended to it
(`<api_url>/requests`). All routes except the webhook need
`Authorization: <Cognito access token>`: the token alone, **without** a `Bearer ` prefix. The gateway's
Cognito user pool authorizer rejects a missing, expired or foreign token with `401` before a Lambda
runs. The protected methods ask for the scope `openid`, so the token must be an **access** token (an ID
token has no `scope` claim). The authorizer accepts the raw access token (checked from a browser). Bodies are
JSON, except the webhook's (XML).

## Model

```
Request {
  id:        string   // ULID, time-sortable
  partner:   string   // 1-100 chars
  subject:   string   // 1-200 chars
  body:      string   // 1-5000 chars
  status:    "created" | "queued" | "sent" | "failed" | "rejected"   // DELIVERY of the message
  createdAt: string   // ISO 8601, UTC
  clientDecision?: {  // what the client did with the delivered message; absent until they act
    decision:   "Approved" | "Declined"
    reason?:    string   // 1-500 chars, text from the recipient's side: show it as text only
    at:         string   // ISO 8601, UTC: when the client acted (OccurredAt of the event)
    receivedAt: string   // ISO 8601, UTC: when we started handling the event
  }
}
```

`status` says whether the message was **delivered**; `clientDecision` says what the client **did**
with it (approved, for example paid; declined, for example out of stock). They are independent:
the decision arrives by webhook, minutes or months after `sent`, and there is no deadline.

The owner (`sub` claim of the token) is stored with the item but never returned.

## Statuses

```
created --(enqueuer put it on the queue)--> queued --(partner answered 2xx)------> sent
   |                                           |--(partner answered 4xx)-------> rejected
   `-------- (the worker may see it first) ----`--(5th attempt failed)---------> failed
   ^                                                                              |
   `------------------------ (the owner sends it again) --------------------------'
```

- `created`: stored by the API. `queued`: on the SQS FIFO queue. `sent`: the partner
  accepted it. `rejected`: the partner refused it for good (retrying is pointless).
  `failed`: delivery attempts are exhausted (the worker has recorded it and acknowledged the
  message; it is not in the DLQ).
- `sent` and `rejected` are **terminal**: they never change again. `failed` is final for the
  worker, but the owner can send the request again (below), which puts it back to `created`.
- Every status change is a conditional `UpdateItem` (`ConditionExpression` on the current
  status), so a late or repeated message cannot move a request backwards.
  `queued` is set only from `created`; the terminal statuses only from `created` or `queued`
  (the worker can pick a message up before the enqueuer has written `queued`); `created` is
  set again only from `failed` (sending it again).
  A failed condition means somebody else already moved the request on: treat it as done,
  not as an error.

## Sending a failed request again

`POST /requests/{id}/retry` (owner only, no body) starts the delivery of a `failed` request
again, through the same pipeline: a request that failed because the recipient was down can be
delivered once it is back.

- One conditional `UpdateItem` on (`pk`, `sk`): `SET status = created`, `ADD retryCount 1`, with
  the condition `status = failed`. Answers `200` with the `Request` (status `created`). Another
  status: `409` `not_retryable` (a request that is `created`, `queued` or `sent` is on its way or
  done; a `rejected` one would get the same answer again). Not the caller's, or unknown, or a
  malformed id: `404`. Pressing twice is safe: the second press finds `created` and gets `409`.
- The API only writes to the table, as for a new request (the outbox): the change is a `MODIFY`
  record in the stream, and the enqueuer accepts it (see "Delivery pipeline"). The API function
  has no queue permission.
- The delivery starts from scratch: five more attempts, and `attempt` in the exchange record
  counts from 1 again. The recipient deduplicates by `MessageId` (the request id), so if it had
  accepted the message before our own error, it answers with the stored answer and the request
  becomes `sent`. The exchange record of the earlier attempt stays until the next attempt
  overwrites it; `clientDecision` is not touched.
- `retryCount` (number) counts the sends after the first; it is never returned.

## Client decision (webhook)

The recipient calls `POST /webhooks/partner` when the client acts. The contract, its schema and
its signature are in `contracts/webhook-api.md` and `contracts/xsd/event.xsd`; this section is
what it means for the request.

- The route is **public** (no Cognito token): it is protected by the signature (HMAC-SHA256 with
  a shared token, in SSM Parameter Store as `/<env>/<project>/webhook-token`, SecureString) and
  throttling: the stage's default limits (5 requests per second, burst 10), and a lower limit of its
  own for this route (2 requests per second, burst 4; the caller reads `429` as "try again", so an
  event is delayed, never lost). It answers `413`, `401`, `415`, `400`, `422`, `404` and `200` as the
  contract says, without a body. The URL the recipient calls contains the stage
  (`<api_url>/webhooks/partner`, the `webhook_url` output), and it changes when the API is created
  again: the recipient's `WEBHOOK_URL` must be set to the current value.
- The event names the request only by id, and the table's key starts with the owner, so the
  function finds the item through the index `by-request-id` (see "Storage") and then updates it.
- `clientDecision` is set with one conditional `UpdateItem`, whatever the delivery `status` is
  (the event may come before `sent` is written, and for a `failed` request too):
  it is written if there is no decision yet, or if the event's `OccurredAt` is later than the
  stored one and the event is not the one already stored (another `EventId`). Anything else (the
  same event again, whatever time it carries; an older one arriving late) changes nothing and is
  answered `200`. The latest `OccurredAt` wins, not the last one received.
- Times are compared as epoch milliseconds, kept in the item next to the text (`decisionAtMs`),
  because ISO strings with different offsets do not sort.
- Nothing waits for the event and nothing expires: no timer, no alarm for a missing decision.

There is no stored "waiting" state and the API never returns one. A request that is `sent` and has
no `clientDecision` is waiting for the client, and the frontend shows it as "Waiting" (derived on
every render, so it turns into Approved or Declined when the decision arrives). For any other
status without a decision (`created`, `queued`, `rejected`, `failed`) no client status is shown.

## Endpoints

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/requests` | `{ partner, subject, body }` | `201` `Request` (status `created`) | `400` validation, `500` |
| GET | `/requests` | | `200` `{ items: Request[] }`, newest first, at most 50 (pagination later) | `500` |
| GET | `/requests/{id}` | | `200` `Request` | `404` (also for a malformed id), `500` |
| POST | `/requests/{id}/retry` | | `200` `Request` (status `created`) | `404` (also for a malformed id), `409` `not_retryable` (the status is not `failed`), `500` |
| GET | `/requests/{id}/exchange` | | `200` `Exchange`; `204`, empty body, when the request is the caller's own and no delivery attempt is recorded yet | `404` (no such request for the caller, also for a malformed id), `500` |
| POST | `/webhooks/partner` | XML `DecisionEvent`, signed | `200`, empty body | `413`, `401`, `415`, `400`, `422`, `404`, `5xx` (see "Client decision"); **no Cognito token** |

`Exchange` is what the worker recorded about the **latest** delivery attempt (see "The exchange
record"). The XML in it is text for a person to read: clients must show it as text and never
interpret it as markup. "No attempt yet" is a normal state of an existing request (it has not
been picked up yet), so it is `204`, not an error; `404` here only ever means that there is no such
request for the caller. Both answers carry `cache-control: no-store`, because the `204` changes
into a `200` as soon as the first attempt is made.

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
{ "error": { "code": "validation_error" | "not_found" | "not_retryable" | "internal_error",
             "message": string, "details"?: unknown } }
```

For `validation_error`, `details` is an array of `{ path: string, message: string }`
(`path` is the dotted JSON path of the invalid field). Errors produced by API Gateway
itself never reach a Lambda and have a different shape, `{ "message": string }`: `401`
(`{ "message": "Unauthorized" }`) for a missing, invalid or expired token on a protected route, `403`
for a path the API does not have, `429` above the throttle, `5xx` if the gateway itself fails.

**Limits at the gateway.** Every method of the stage is throttled to 5 requests per second with a burst
of 10, and the public webhook method to 2 and 4; above the limit the answer is `429`. API Gateway waits
at most 29 s for a function (the functions' own timeout is 10 s, and the frontend gives up after 15 s).
Execution logs and detailed metrics are off (they would write whole requests, tokens included, and be
billed as custom metrics): the access log is the only log of the API ("Logs").

**CORS**: `Access-Control-Allow-Origin: *`, and never `Access-Control-Allow-Credentials`. `*` is
acceptable because authorization is a token that the page puts into a header, not a cookie. A REST API
has no CORS switch, so it is built by hand:
- The gateway answers the preflight `OPTIONS` of every path that has a route (a `MOCK` integration: `200`,
  no Lambda runs) with `Access-Control-Allow-Headers: Content-Type,Authorization,X-Amzn-Trace-Id`
  ("Traces") and `Access-Control-Allow-Methods` listing the methods of that path and `OPTIONS`. These
  `OPTIONS` methods have no authorizer: a preflight never carries `Authorization`.
- Every response of a function carries `Access-Control-Allow-Origin: *` (one place:
  `backend/src/lib/http.ts`, error responses included), and the gateway adds it to its own 4xx and 5xx
  answers (gateway responses), so the browser can read the status of a failure instead of a generic
  network error.

## Storage

Table `<project>-<env>-requests`, provisioned 5 RCU / 5 WCU, no autoscaling.
**DynamoDB Streams is on, view type `NEW_IMAGE`** (see "Delivery pipeline").

| Key | Attribute | Value |
|---|---|---|
| partition | `pk` (S) | `USER#<sub>` |
| sort | `sk` (S) | `REQ#<ULID>` |

Other attributes: `id`, `partner`, `subject`, `body`, `status`, `createdAt`, `retryCount` (once
the request has been sent again), `traceparent` (the W3C trace context of its creation or of the last
resend: see "Traces"; never returned), and once the client has acted `clientDecision` (a map: the fields of "Model" plus `eventId`, the id of the event
that set it, kept for the "same event" rule and never returned) and `decisionAtMs` (number, epoch
milliseconds of `clientDecision.at`, for the comparison of the webhook).

Index `by-request-id` (GSI): partition key `sk` (S), no sort key, projection `KEYS_ONLY`
(`pk` and `sk`), provisioned 5 RCU / 5 WCU. It serves one access pattern: find an item by
request id without knowing the owner (the webhook). `sk` is `REQ#<ULID>`, unique across the
table because ULIDs are. Items that existed before the index are added to it by DynamoDB.

- List = `Query` on `pk`, `ScanIndexForward=false`, `Limit=50`.
- Get = `GetItem` on (`pk`, `REQ#<id>`).
- `pk` is always built from the token's `sub`, never from client input, so one user cannot
  address another user's items. The webhook is the one caller without a `sub`: it reaches an
  item only through `by-request-id` and only to set `clientDecision`.
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
                                                                 `-> a message that cannot be processed -> DLQ (kept for inspection)
POST /requests/{id}/retry -> DynamoDB (failed -> created) -> stream -> enqueuer -> ... as above
GET /requests/{id}/exchange -> the XML we sent and the XML that came back
```

**Outbox through DynamoDB Streams.** The API only writes to the table. The stream feeds the
`enqueuer`, so a request cannot be stored without also being queued (at least once), and the
API needs no permission for the queue.

**enqueuer** (event source mapping on the stream):
- Filter: a new request (`INSERT`) or a request sent again (`MODIFY` whose new image has status
  `created` and a `retryCount`), so the status updates of the pipeline (`queued`, `sent`, ...) do
  not trigger it again. Only the new image is in the stream, so "was `failed`" cannot be tested; a
  `created` request with a `retryCount` is the sending-again state, and the worst a stray record
  can do is a message that the queue's deduplication drops.
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
  per partner; a failing message blocks its own partner's later messages until it is
  acknowledged (its last attempt) or in the DLQ.
- `MessageDeduplicationId` = `requestId` for the first send and `<requestId>-r<retryCount>` for
  a send after a retry, so that a request sent again is never taken for a duplicate of its first
  message. No content-based deduplication.
- Visibility timeout 120 s (at least 6 x the worker timeout), `maxReceiveCount` 5, retention
  4 days on the queue and 14 days on the DLQ, server-side encryption on.

**Inspecting and redriving the DLQ.** `backend/scripts/redrive-dlq.mjs` is a small operator CLI
(`list`, `redrive <messageId>`, `discard <messageId>`) that the owner runs locally with their
own AWS profile: no new Lambda, no IAM role, no Terraform change. `list` is read-only; `redrive`
resends one message to the delivery queue and only then removes it from the DLQ; `discard`
removes one message for good, without resending it. The judgement call is the human's: redrive
an "error" outcome (our own infra hiccup) once the underlying problem is fixed, discard an
"undeliverable" one (a malformed message, or the request is gone) because it will never succeed.

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
   On the **last** attempt (`ApproximateReceiveCount >= MAX_RECEIVE_COUNT`) set `failed`, publish
   it (an e-mail), and **acknowledge** the message: the failure is handled, the owner sees it with
   a "Send again" button, the partner's group is not held back, and the DLQ stays for what could
   not be processed at all (step 10). `MAX_RECEIVE_COUNT` comes from Terraform, the same value as
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
  owner's e-mail subscription has no filter. CloudWatch alarms: DLQ depth >= 1 (a message
  that could not be processed: a bug or a broken dependency, not a delivery the recipient refused)
  (`ApproximateNumberOfMessagesVisible`) and enqueuer `IteratorAge` above 5 minutes.
- The e-mail address is the `notification_email` Terraform variable (in CI a GitHub secret).
  Each subscription needs a confirmation click.

## Lambda contract

| Function | Trigger | DynamoDB | Other permissions (all resource-scoped) |
|---|---|---|---|
| `create-request` | `POST /requests` | `PutItem` | |
| `list-requests` | `GET /requests` | `Query` | |
| `get-request` | `GET /requests/{id}` | `GetItem` | |
| `retry-request` | `POST /requests/{id}/retry` | `UpdateItem` | |
| `enqueuer` | DynamoDB stream | `UpdateItem` | stream read; `sqs:SendMessage` on the queue; `sns:Publish` on `alerts` |
| `delivery-worker` | SQS queue | `GetItem`, `UpdateItem` | queue receive/delete/attributes; `sns:Publish` on `request-status`; `s3:PutObject` on `exchanges/*`; `ssm:GetParameter` on the API key parameter |
| `receive-webhook` | `POST /webhooks/partner` (public) | `Query` on `by-request-id`, `UpdateItem` | `ssm:GetParameter` on the webhook token parameter |
| `log-archiver` | CloudWatch Logs subscription (asynchronous) | | `s3:PutObject` on `logs/*` of the log archive bucket |
| `get-exchange` | `GET /requests/{id}/exchange` | `GetItem` | `s3:GetObject` on `exchanges/*`; `s3:ListBucket` on the bucket (without it S3 answers a missing key with 403 instead of 404; a prefix condition would not help, a GetObject request carries no prefix) |

- Runtime `nodejs24.x`, `arm64`, no VPC, handler `index.handler`, memory 256 MB (512 MB for the functions that
  are traced, see "Traces"). Timeouts:
  API functions, `receive-webhook`, `enqueuer` and `log-archiver` 10 s, `delivery-worker` 15 s.
- The account allows only 10 concurrent Lambda executions, so no reserved concurrency; the two
  event source mappings that need it are capped (`maximum_concurrency` 2 on the queue).
- API events: REST API, Lambda proxy integration, payload format 1.0: `event.httpMethod`,
  `event.resource` (the path template, `/requests/{id}`), `event.pathParameters`, `event.headers` (the
  names as the caller wrote them: look them up ignoring case), `event.body` (a string, or `null` when
  the caller sent none). The owner is `event.requestContext.authorizer.claims.sub`, put there by the
  Cognito authorizer (the public webhook route has no authorizer, so no claims).
- API responses are `{ statusCode, headers, body }` and every one carries
  `Access-Control-Allow-Origin: *`: with a proxy integration the gateway adds no header to what the
  function returns, so `backend/src/lib/http.ts` adds it in the one place where a response is built.
- Environment, all functions: `LOG_LEVEL` (default `info`), `NODE_OPTIONS=--enable-source-maps`
  (the build is minified; the source map keeps stack traces readable). Per function:
  API functions `TABLE_NAME`; `get-exchange` `TABLE_NAME`, `AUDIT_BUCKET`; `enqueuer`
  `TABLE_NAME`, `QUEUE_URL`; `delivery-worker` `TABLE_NAME`, `PARTNER_URL`,
  `PARTNER_API_KEY_PARAM`, `SENDER_NAME` (default `aws-starter`), `TOPIC_ARN` (request-status),
  `AUDIT_BUCKET`, `MAX_RECEIVE_COUNT`; `receive-webhook` `TABLE_NAME`, `WEBHOOK_TOKEN_PARAM` (the
  SSM parameter name); `log-archiver` `ARCHIVE_BUCKET` (no table).
- The XSD files of `contracts/xsd/` are copied into the package of every function that needs
  them (`schemas/` next to `index.mjs`) by the build; the packaged copy is the sender's own copy
  of the contract.
- Build output: `backend/dist/<function>/index.mjs` (plus a source map). Terraform zips each
  directory with `archive_file`; the build does not produce zips.

## Logs

- **Where**: CloudWatch Logs. One log group per Lambda (`/aws/lambda/<function>`) and one for the
  API's access log (`/aws/apigateway/<project>-<env>-api`), all kept **30 days** (the hot tier: fast
  to search with Logs Insights). The access log is one JSON object per request with `requestId`,
  `httpMethod`, `resourcePath`, `status`, `responseLatency`, `integrationLatency` and `integrationStatus`:
  no client IP, user agent or token claims.
  (The recipient, `partner-sim`, is another organisation's system: its logs are not ours to read.)
- **Metrics, alarms, dashboard** (module `infra/modules/observability`), all inside the free tier:
  - 8 custom metrics in the namespace `<project>/<env>`, without dimensions (a dimension multiplies
    the count, and 10 are free). Six are **counted from the log lines** by metric filters:
    `DeliverySent`, `DeliveryRejected`, `DeliveryFailed`, `DeliveryRetried` (the worker), `WebhookUnauthorized`
    (the webhook function) and `LogGuardHits` (every function: a line with `[unlisted]` or `[rejected]`
    is a bug). The filters match on **terms**, not on JSON: a Lambda log line is
    `timestamp<TAB>requestId<TAB>LEVEL<TAB>{json}`, which is not JSON as a whole. Two are **durations**,
    which a filter cannot read out of such a line, so the worker writes them as embedded-metric-format
    lines (`src/lib/metrics.ts`): `TimeToSentMs` (creation to `sent`) and `PartnerMs` (the call to the
    recipient). They are written only when `METRICS_NAMESPACE` is set (Terraform sets it on the worker).
  - 8 alarms, to the `alerts` topic, that with the two older ones use all 10 free: worker errors,
    webhook errors, worker duration p95 over 80 % of its timeout, API 5xx, oldest queue message older
    than 10 minutes, DynamoDB write throttling, five webhook signature failures in five minutes, a log
    guard hit.
  - The API's own metrics come from API Gateway (namespace `AWS/ApiGateway`, dimensions `ApiName` and
    `Stage`): `Count`, `4XXError`, `5XXError`, `Latency`. The two error metrics count requests, so the
    alarm and the dashboard use `Sum`. Detailed metrics are off (they are billed as custom metrics); the
    basic metrics appear all the same (checked on AWS).
  - One dashboard, `<project>-<env>-delivery`, and saved Logs Insights queries (the timeline of one
    request, failed requests, the slowest deliveries, attempts by outcome, webhook events, guard hits).
- **One JSON object per line**: `level`, `message` and fields. The `message` is a fixed sentence of
  at most 120 characters, on one line; data goes in fields.
- **Which fields**: only those on the list in `backend/src/lib/log-fields.ts`, each with a shape for
  its value (an id, a word from a closed list, a number, a boolean, a list of validator findings,
  a route template). Anything else is written as `"[unlisted]"` (an unknown field) or `"[rejected]"`
  (a known field with a value of the wrong shape): the name stays, the value never reaches the
  log. There are no free-text fields except the message and the stack of an error, and those have
  every quoted piece replaced (`'...'`, `"..."`) and a length cap, because parsers quote the value
  that made them fail. Nested objects are never written.
- **In tests the guard throws** (`LOG_STRICT=1` in `vitest.config.ts`): a log call it would have to change
  fails the test. In Lambda it never throws, because logging must not break a handler.
- **Request events**: one line for each change in the life of a request, written when the change is
  really applied (a conditional update that succeeded; never for a duplicate, an ignored event or a
  refused change). The message is always `Request event`; the fields are:

  | `event` | written by | `role` | other fields |
  |---|---|---|---|
  | `request_created` | `create-request` | `user` | `toStatus` = `created` |
  | `request_queued` | `enqueuer` | `enqueuer` | `fromStatus` `created`, `toStatus` `queued` |
  | `delivery_attempted` | `delivery-worker`, after every attempt | `worker` | `attempt` (the receive count), `outcome` (`delivered`, `refused`, `retry`, `invalid_request`, `unrepresentable`), `httpStatus` and `partnerMs` when the recipient was called |
  | `request_sent`, `request_rejected`, `request_failed` | `delivery-worker` | `worker` | `toStatus`, `attempt`, `sinceCreatedMs` (from creation to this moment) |
  | `retry_requested` | `retry-request` | `user` | `fromStatus` `failed`, `toStatus` `created`, `retryCount` (the new value) |
  | `decision_recorded` | `receive-webhook` | `recipient` | `decision` (`Approved` or `Declined`) |

  All lines carry `requestId` (and, like every line of a function, `awsRequestId`), and `traceId` when
  they are written inside a trace ("Traces"). There is no user
  id and no text: `role` says who acted. The events are the audit trail of the request (the table
  keeps only the current status), and the source of the delivery metrics and of the request
  timeline. What to know when reading them:
  - An event is written **after** its write. A crash between the two loses the line, and the retried
    message then finds the request already finished and writes nothing: the trail is at most once.
  - `delivery_attempted` is written before the exchange record and the status. If the record cannot
    be written, the message is retried and writes another attempt with a higher `attempt`. An
    attempt that ends in an error of ours (a crash) has no `delivery_attempted` line, only the
    technical line `Delivery attempt crashed`.
- **The timeline of one request**, across all functions, in Logs Insights (select all the log groups
  of the project; the JSON fields of our lines are parsed by Insights, no `parse` needed):

  ```
  fields @timestamp, event, fromStatus, toStatus, role, attempt, outcome, httpStatus, partnerMs, sinceCreatedMs
  | filter requestId = "<the ULID>" and ispresent(event)
  | sort @timestamp asc
  ```
- **Never in a log**: the text of a request, the partner's name, a reason, the XML, a token, a
  signature, a header, an event. A new field is added to the list in a reviewed diff.

## Log archive

Logs older than the 30 days of CloudWatch Logs are kept in S3 for **395 days** (13 months) and
queried with Athena. The logs hold no personal data (the log guard, "Logs"), so a long archive is safe.

- **Pipeline** (module `infra/modules/log-archive`): a subscription filter on every Lambda log group
  and on the API access log group (empty pattern: everything) invokes the `log-archiver` function
  with each batch of log events. The function writes the batch to S3, gzip-compressed, one JSON
  object per line: `s3://<project>-<env>-log-archive-<account id>/logs/year=YYYY/month=MM/day=DD/<hash>.json.gz`.
  A line is the envelope CloudWatch Logs sends: `messageType`, `owner` (the AWS account id, which is
  why the bucket is private), `logGroup`, `logStream`, `logEvents[]` (`id`, `timestamp` in
  milliseconds, `message`). A batch that spans midnight (UTC) becomes one object per day, so a line is
  filed under the day it was logged. The object name is the hash of its content: a batch delivered
  twice (Lambda retries a failed asynchronous invocation twice) overwrites itself, so no line is
  archived twice. CloudWatch's `CONTROL_MESSAGE` health check is not written.
- **Failure modes**: the archive is a copy, the lines are still in CloudWatch Logs for 30 days. A
  batch that fails all three tries (an S3 outage of minutes) is dropped, and nothing is queued for
  later. The archiver's own log group is not archived (it would trigger itself; Terraform refuses to
  subscribe it). There is no alarm on it: the account is at the 10 free alarms. Its runs and errors
  are on the dashboard `<project>-<env>-delivery`.
- **Only what is logged after the archive exists is in it**: there is no backfill of older lines.
- **Querying**: Athena workgroup `<project>-<env>-logs` (a fixed result location under
  `athena-results/`, kept 7 days, and a **1 GB scan limit per query**), Glue database
  `<project>_<env>_logs`, table `log_archive`, partitioned by `year`, `month` and `day` (partition
  projection: nothing to crawl or repair). **Every query filters on the date**: without it Athena
  reads every day of the range. Two saved queries: the timeline of one request (the archive
  counterpart of the Logs Insights query in "Logs") and failed requests per day. A line is
  `timestamp<TAB>requestId<TAB>LEVEL<TAB>{json}`, so the queries take the JSON out of `message` with
  `regexp_extract` first.
- **Cost**: the function's runs are inside the always-free Lambda allowance; S3 PUT requests, S3
  storage and Athena are billed by use, and at a few MB of logs a month the archive costs cents.
  Standard-IA is not used: it bills at least 128 KB per object and the objects here are tiny.

## Traces

One request is one trace: from the user's action in the browser, through API Gateway and the creation
of the request, the stream, the enqueuer and the queue, to the delivery, the call to the recipient and
the decision webhook. It starts at the front door (the first bullet); the rest takes two halves that fit
together.

- **The start: the browser makes the id, API Gateway is a node.** X-Ray tracing is on for the stage of
  the REST API, so API Gateway records a segment of its own (the time spent before the function starts).
  It continues a trace whose id arrives in the request header `X-Amzn-Trace-Id` instead of making a new
  one. The frontend (`frontend/src/shared/api/trace-header.ts`) puts a fresh id in that header,
  `Root=1-<8 hex: epoch seconds>-<24 random hex>;Parent=<16 random hex>;Sampled=1`, on every request
  that changes something (`POST /requests`, `POST /requests/{id}/retry`); a read sends none. So the trace
  of a user action starts with an id made in the browser. The id is neither a secret nor personal data.
  The browser only makes the id: it sends no segments to X-Ray and is not a node. The header is in the
  CORS `Access-Control-Allow-Headers` ("Endpoints"), or the browser would not send it. API Gateway continues
  the browser's id (checked on AWS: the gateway span has the parent id that the browser made), and the
  spans of `create-request`, the enqueuer and the worker belong to that same trace.
- **The SDK and the exporter are AWS's.** The Lambda layer `AWSOpenTelemetryDistroJs` (pinned, version
  14) is attached to the functions that write: `create-request`, `retry-request`, `receive-webhook`,
  the `enqueuer` and the `delivery-worker`. Its start script (`AWS_LAMBDA_EXEC_WRAPPER`) starts the
  OpenTelemetry SDK before our code, makes a span for every invocation and sends the spans to the
  X-Ray OTLP endpoint, signed with the function's role: no collector. The calls made through `http` and
  `fetch` (DynamoDB, SQS, SNS, S3, SSM, the recipient) become client spans with the host and the
  status. The spans of an invocation that Lambda itself records (`Init` and `Overhead`, that is the
  start-up) stay in the trace of the invocation, not in the request's. These functions have 512 MB. Lambda's active tracing stays on: it records the invocation
  itself (`Init`, `Overhead`) and, for a queue message, links the invocation to the message's trace.
- **The trace context is carried by our code** (`src/lib/tracing.ts`, the OpenTelemetry API only: without
  the layer every call does nothing), because the stream and the HTTP webhook carry no trace:
  - `create-request` and `retry-request` store a W3C `traceparent` in the request item, in the same
    write (a retry replaces it: it starts a new trace). It is never returned by the API.
  - The enqueuer reads it from the stream image, records a span `enqueue request` in that trace and
    puts the X-Ray form of it into the queue message (the system attribute `AWSTraceHeader`, which needs
    no permission beyond `sqs:SendMessage`).
  - The worker reads that header from the record. Lambda's own tracing does not join a consumer to the
    trace of the message: it starts a trace of the invocation and only links it (seen on AWS). So the
    worker makes a span `deliver request` for each attempt, with the header as its parent, and the calls
    of the attempt are nested in it.
  - The webhook gets the stored `traceparent` with the answer of its update (`ReturnValues: ALL_OLD`: no
    extra read, and only that attribute is used) and records a span `record decision` in that trace after
    the fact, from the moment its call began.
  - Every port (repository, client, queue, store) is wrapped once in its container: each call is a span
    `<port>.<method>`, without arguments or results. The worker's call to the recipient is a span
    `call recipient`.
- **What a span may hold**: the same as a log line. Attributes pass the guard of `lib/log-fields.ts`
  (a name on the list, a value of its shape), an error is recorded by its type only, never its message,
  and `recordException` is not used.
- **Where the spans are**: CloudWatch Transaction Search. X-Ray keeps every span as a structured log in
  the group `aws/spans` (30 days) and indexes 1 % of the traces for the X-Ray console (1 % is free). The
  `Request event` lines carry the `traceId` of the trace they belong to: search `aws/spans` for it.
- **Not in a trace**: the browser as a node (it only makes the id); the functions the browser polls
  (`list-requests`, `get-request`, `get-exchange`); the `log-archiver`.
- **Cost**: in money, span ingestion is log ingestion, inside the 5 GB free a month, and the layer is
  free. In time, measured (256 MB without the layer, 512 MB with it): the start-up of a cold function
  went from 0.31 to 0.43 s to 1.1 to 2.4 s, and the memory in use grew by 95 to 150 MB. The XML
  validator started a worker thread per check, and every thread started the whole SDK again, which made
  a warm `receive-webhook` take 1.7 s instead of 0.75 s; the build now changes the copy of `xmllint-wasm`
  so that its worker starts without the layer's option (`scripts/build.mjs`), and the same call takes
  0.5 to 0.7 s.
- **IAM**: the two write actions (`xray:PutTraceSegments`, `xray:PutTelemetryRecords`) on `*`: X-Ray
  has no resource-level permissions for them. Only the traced functions get them.

## Service Level Objectives

Three SLOs, each an attainment percentage (or, for the third, a duration) over a **30-day rolling
window**, read from metrics the project already has:

- **API availability, target ≥ 99.5 %**: `100 - (5XXError_sum / Count_sum * 100)`, from
  `AWS/ApiGateway` `Count` and `5XXError` (dimensions `ApiName`, `Stage`, "Logs"), `Sum` over 30
  days.
- **Delivery success, target ≥ 95 %**: `DeliverySent_sum / (DeliverySent_sum + DeliveryFailed_sum)
  * 100`, from the existing custom metrics `DeliverySent` and `DeliveryFailed` (namespace
  `<project>/<env>`, "Logs"), `Sum` over 30 days. `DeliveryRejected` is deliberately **not** one of
  the operands: it is the partner's own business refusal (out of stock, wrong recipient, a
  malformed name, ...), not a failure of this stack to deliver. The 95 % target itself is loose on
  purpose: the recipient's uptime is another organisation's to run, not this project's to promise.
- **Time to sent, p95, target ≤ 5 min**: the existing `TimeToSentMs` metric (namespace
  `<project>/<env>`), `p95` over 30 days, against a 300000 ms line.

They are drawn as attainment widgets on the existing dashboard
(`infra/modules/observability/dashboard.tf`, "Service level objectives"), not as new CloudWatch
alarms, because the account's 10 free alarms are already spent by the metrics/alarms stage
("Logs"): an SLO is meant to be read over a month, not paged on within minutes.
