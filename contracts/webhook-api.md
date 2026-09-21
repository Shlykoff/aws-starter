# Webhook contract: the client's decision

The **recipient** of the submissions calls the **sender's** webhook when the client has acted on
a delivered message: approved it (for example paid) or declined it (for example out of stock).
The two contracts are separate and run in opposite directions:

| | Direction | What it tells | Contract |
|---|---|---|---|
| submission and its reply | sender → recipient | was the message delivered and understood | [`partner-api.md`](partner-api.md) |
| decision event | recipient → sender | what the client did with it | this file |

The client may act minutes, days or months after the delivery. **There is no deadline** in this
contract: the sender never gives up waiting, and never refuses an event because the request is
old.

## What the sender publishes

One URL, `POST <webhook url>`, on the public internet, and one shared secret, the **token**. The
recipient is given both once, out of band (in the simulator: the environment variables
`WEBHOOK_URL` and `WEBHOOK_TOKEN`).

## The request

| Part | Value |
|---|---|
| `Content-Type` | media type `application/xml`; any other gets `415`. Parameters are ignored |
| `X-Webhook-Timestamp` | the time the request was signed: whole seconds since 1970-01-01 UTC, decimal digits only |
| `X-Webhook-Signature` | `v1=` followed by 64 lower-case hex digits: HMAC-SHA256 with the token (UTF-8 bytes) as the key, over the bytes of the timestamp text, one `.` and the **body exactly as sent** |
| Body | one XML document valid against `xsd/event.xsd`, at most **65 536 bytes** |

The token itself never travels. A worked example is in
`fixtures/event/signature-vector.json`; both sides' tests must reproduce it.

Every attempt to deliver gets a **new timestamp and a new signature**. A repeated delivery of the
same event keeps the same `EventId` and the same body.

## What the sender does, in this order

The order matters: nothing expensive happens before the signature is right.

1. Body larger than 65 536 bytes: `413`.
2. Timestamp missing, not decimal digits, or more than **300 seconds** away from the sender's
   clock in either direction; signature missing, not `v1=` + 64 hex digits, or not equal to the
   one the sender computes (compared in constant time): `401`, no body. The 300 seconds limit the
   age of a **signed request**, so that a captured request cannot be replayed later. It has
   nothing to do with when the client acted.
3. Media type: `415`.
4. Parses the document. Not well-formed, or **any** DOCTYPE at all: `400`.
5. Validates it against `xsd/event.xsd`: `422`.
6. Looks up the request `RelatesTo`. Unknown: `404`.
7. Applies the event (below) and answers `200`, empty body.

Every answer other than `200` has no body.

## Applying an event

The sender keeps **one current decision per request**: the event with the latest `OccurredAt`.

| Situation | The sender |
|---|---|
| no decision yet | stores it, `200` |
| same `EventId` as the stored decision (a repeated delivery) | changes nothing, `200` |
| `OccurredAt` later than the stored decision | replaces it, `200` |
| `OccurredAt` equal to or earlier than the stored decision, other `EventId` (an old event arriving late) | changes nothing, `200` |

Ignored events are acknowledged with `200` on purpose: retrying would not change the answer. The
decision is independent of the delivery status of the request: an event may arrive before the
sender has recorded the delivery as `sent`, and it is accepted whatever the status is.

## How the recipient reads the answer

| Answer | Meaning |
|---|---|
| any `2xx` (this sender answers `200`) | delivered |
| `429`, `5xx`, no answer, timeout | temporary: try again |
| `401` | the token or the clocks are wrong: fix the configuration, then send the same event again (new timestamp) |
| any other `4xx` | the event itself is wrong: do not retry |
