# API contract (stage 1)

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

Statuses: `created` (stored) -> `queued` (in SQS FIFO) -> `sent` (partner answered 2xx).
`failed`: delivery retries exhausted, message is in the DLQ. `rejected`: XML failed schema
validation, not retried. **Stage 1 only ever sets `created`.**

## Endpoints

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/requests` | `{ partner, subject, body }` | `201` `Request` | `400` validation, `500` |
| GET | `/requests` | | `200` `{ items: Request[] }`, newest first, at most 50 (pagination later) | `500` |
| GET | `/requests/{id}` | | `200` `Request` | `404` (also for a malformed id), `500` |

A request that belongs to another user is `404`, not `403`, so existence is not leaked.
A missing `sub` claim on a protected route is a misconfiguration and answers
`500 internal_error` (the reason is logged, the token is not). Reads are eventually
consistent: a list requested right after a create may briefly miss the new item, so
clients should use the `POST` response.

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

| Key | Attribute | Value |
|---|---|---|
| partition | `pk` (S) | `USER#<sub>` |
| sort | `sk` (S) | `REQ#<ULID>` |

Other attributes: `id`, `partner`, `subject`, `body`, `status`, `createdAt`.

- List = `Query` on `pk`, `ScanIndexForward=false`, `Limit=50`.
- Get = `GetItem` on (`pk`, `REQ#<id>`).
- `pk` is always built from the token's `sub`, never from client input, so one user cannot
  address another user's items. No GSI in stage 1.
- Known limit: read capacity is charged by the size of the items read, not by the fields
  returned, so dropping `body` from the list response would not lower it. A page of 50
  items with maximum-size bodies (about 265 KB) costs roughly 33 RCU per call with
  eventually consistent reads, against 5 provisioned RCU. Burst capacity covers occasional
  calls; refreshing the list in a tight loop could throttle.

## Lambda contract

| Function | Route | DynamoDB action it may call |
|---|---|---|
| `create-request` | `POST /requests` | `PutItem` |
| `list-requests` | `GET /requests` | `Query` |
| `get-request` | `GET /requests/{id}` | `GetItem` |

- Runtime `nodejs24.x`, `arm64`, no VPC, handler `index.handler`, timeout 10 s, memory 256 MB.
- Event: API Gateway HTTP API payload format 2.0 with JWT authorizer
  (`event.requestContext.authorizer.jwt.claims.sub`).
- Environment: `TABLE_NAME`, `LOG_LEVEL` (default `info`), `NODE_OPTIONS=--enable-source-maps`
  (the build is minified; the source map keeps stack traces readable).
- Build output: `backend/dist/<function>/index.mjs` (plus a source map). Terraform zips each
  directory with `archive_file`; the build does not produce zips.
