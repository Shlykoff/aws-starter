# Partner API (v1)

The HTTP contract that a recipient ("partner") offers to the sender. It says nothing about how
the recipient is built or where it runs: it may live in another cloud, behind a tunnel, or on a
laptop. The sender knows two things about it: a base URL and an API key.

## Authentication

Every request carries the header `X-API-Key: <key>`. The key is issued by the partner and kept
by the sender as a secret. A missing or wrong key gets `401` and no body.

## `POST /v1/submissions`

Delivers one submission.

| Part | Value |
|---|---|
| `X-API-Key` | required |
| `Content-Type` | media type `application/xml`; any other media type gets `415`. Parameters (such as `charset`) are ignored: the document's own XML declaration decides its encoding |
| `Idempotency-Key` | optional, informational: the `MessageId` of the submission. The recipient deduplicates by the `MessageId` **inside the document**, never by this header |
| Body | one XML document valid against `xsd/submission.xsd`, at most **65 536 bytes** (`413` above that) |

### What the recipient does, in this order

1. Checks the key (`401`), the content type (`415`) and the size (`413`).
2. Parses the document. Not well-formed, or **any** DOCTYPE at all (this shuts out external
   entities and entity-expansion attacks by policy) gives `400`, reply `Rejected`,
   code `MALFORMED_XML`, no `RelatesTo`.
3. Validates it against `xsd/submission.xsd`. A violation gives `422`, reply `Rejected`, code
   `SCHEMA_INVALID`. `RelatesTo` is the `MessageId` of the submission if it is a valid ULID
   (read from the submission namespace: an id in another namespace counts as absent),
   otherwise absent. `Description` names the first problem (at most 500 characters).
4. If a submission with the same `MessageId` was already answered, it returns **the stored answer
   again: same status, same body**. Nothing is stored or processed twice. This makes the
   sender's retries safe. Only documents that passed step 3 are matched: a schema-invalid one is
   answered anew every time and never blocks a corrected document with the same id.
5. Applies its own rules. The simulator has two, keyed on the `Subject` text (case-sensitive; if
   both are present, `[reject]` wins), to make failures easy to show:
   - contains `[reject]`: `422`, reply `Rejected`, code `RECIPIENT_REJECTED`
   - contains `[fail]`: `503` with `Retry-After: 1` and **no body**; nothing is stored, so a
     later attempt is treated as new
6. Otherwise: `200`, reply `Accepted`.

### Responses

| Situation | Status | Body |
|---|---|---|
| Accepted | `200` | `Reply`, `Result/Status` = `Accepted`, no `Code` |
| Not well-formed, or has a DOCTYPE | `400` | `Reply`, `Rejected`, `MALFORMED_XML` |
| Violates the schema | `422` | `Reply`, `Rejected`, `SCHEMA_INVALID` |
| Refused by the recipient's own rules | `422` | `Reply`, `Rejected`, `RECIPIENT_REJECTED` |
| Wrong key | `401` | none |
| Wrong content type | `415` | none |
| Too large | `413` | none |
| Temporarily unavailable | `503` | none |

Every `Reply` body is `application/xml; charset=utf-8` and valid against `xsd/reply.xsd`.
`Code` and `Description` are present exactly when the status is `Rejected`; `RelatesTo`,
`MessageId` (a fresh UUID) and `ReceivedAt` (UTC, `Z`) are set by the recipient.

### How the sender reads the answer

| Answer | Meaning for the sender |
|---|---|
| `200` + `Accepted` | delivered |
| `400` or `422` + `Rejected` | refused for good: do not retry |
| `401`, `403`, `408`, `429`, any `5xx`, no answer, timeout | temporary or our own configuration: retry |
| any other `4xx` (`413`, `415`, ...) | our request is wrong: do not retry |

A `200` whose body is not a valid `Reply`, or a `Reply` that breaks the rule about `Code`, is a
protocol violation by the recipient and is treated as a temporary failure.

The table has gaps, and the sender fills them with the cautious reading: try again, never a
silent "delivered" or "refused". A retry is safe, because the recipient answers a repeated
`MessageId` with the answer it stored. A real fault then ends as `failed` with an alarm.

| Answer | Meaning for the sender |
|---|---|
| `200` + a valid `Rejected` reply, or `400`/`422` + a valid `Accepted` reply | the status and the body disagree: retry |
| a `Reply` whose `RelatesTo` is present and is not our `MessageId` | not an answer to this message: retry |
| `1xx`, `3xx` (a redirect is never followed: the key must not travel to another host), `2xx` other than `200` | not defined by this contract: retry |
| `400`/`422` with no body or an invalid body | the status decides: refused |
| a body of more than 64 KiB, or one that is not UTF-8 | not a `Reply`: the status decides (`200` = retry, as above) |

## `GET /healthz`

`200` with `{"status":"ok"}`. No key needed. For load balancers and container health checks.
