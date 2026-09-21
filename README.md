# aws-starter

A small reference project for running serverless services on AWS: Terraform for
infrastructure, Node.js + TypeScript on Lambda, a React frontend. It is built
around a demo scenario, sending requests to a partner system, that has two paths:

- **User path**: React -> API Gateway -> Lambda -> DynamoDB, authenticated with Cognito.
- **Delivery path**: a request is queued in SQS FIFO; a worker Lambda builds an XML
  message, validates it against an XSD and posts it over HTTPS to a separate system (the
  recipient); it reads and validates the XML answer. Status changes are published to SNS,
  messages that keep failing land in a DLQ.

All data is fake. The domain is deliberately neutral.

## Status

- [x] Stage 0: bootstrap (state bucket, budget alert, GitHub OIDC role)
- [x] Stage 1: REST API (API Gateway, Lambda, DynamoDB), Cognito, React login + list/form, CI/CD
- [x] Stage 2: async delivery (stream outbox, SQS FIFO, worker, DLQ, SNS). Checked on AWS
  with three requests: delivered, refused and failing (five attempts, then `failed`, the
  DLQ and the alarm).
- [ ] Stage 3: the recipient as a separate system (`partner-sim/`, `contracts/`), XML + XSD
  validation on both sides, the exchange record and its panel in the UI, the API key in SSM;
  still to do: PII masking review of the logs, mTLS, a README with diagrams and a quickstart

## Layout

```
bootstrap/   one-off Terraform: state bucket, budget, GitHub OIDC role
infra/       main Terraform stack (remote state), modules per service   [stage 1]
backend/     Node.js + TypeScript Lambda handlers                        [stage 1]
frontend/    React app                                                   [stage 1]
contracts/   what both sides share: XSD schemas, the HTTP contract, sample messages [stage 3]
partner-sim/ the recipient: a separate Python app (FastAPI, lxml, SQLite, Docker)   [stage 3]
docs/        API contract (docs/api.md)
```

## Decisions

Written down as they are made; each stage adds its own.

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
  On-demand would be the choice for spiky or unknown traffic.
- **Request statuses separate temporary from permanent failures:** `created` (stored)
  -> `queued` (in SQS FIFO) -> `sent` (the recipient accepted it). `failed` means delivery
  retries are exhausted and the message is in the DLQ; `rejected` means the message was
  refused for good (the recipient said no, or our own XSD check failed) and is not retried.
- **HTTP API instead of REST API.** Cheaper, lower latency and it has a built-in JWT
  authorizer, so no authorizer Lambda is needed. The REST-only features (API keys,
  usage plans, request validation) are not needed here.
- **Cognito: Essentials tier with the classic hosted UI** instead of managed login. The
  classic UI covers login, logout and password reset, and managed login needs an extra
  branding resource before it renders anything.
- **Outbox through DynamoDB Streams.** The API only writes to the table; the stream feeds
  an `enqueuer` Lambda that puts the request on the queue. A request cannot be stored
  without also being queued (at least once), and the API has no queue permissions. Rejected:
  the API sending to SQS after the write, which leaves a gap when the send fails.
- **SQS FIFO with a hashed partner as the message group, one message per invocation.** The
  group id is a hash of the partner name (a group id may only hold letters, digits and
  punctuation, and a partner is free text), so order is kept per partner. Batch size is 1:
  in a FIFO batch a failing message drags the messages behind it, other partners' included,
  into retries, and each retry is charged a receive, so they could reach the DLQ untried.
- **The dead-letter queue is a quarantine, not a pipe.** The worker writes `failed` itself on
  the last attempt (the number of attempts comes from Terraform, one source of truth), and the
  message then moves to the DLQ, where it stays for inspection and raises an alarm. A function
  reading the DLQ would delete exactly what the alarm is meant to show.
- **A 401 or 403 from the partner is retried, not rejected.** It means our own credentials or
  permissions are wrong, so it ends as `failed` with an alarm instead of a silent `rejected`.
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
- **The exchange record is one S3 object per request**, holding the XML sent and the reply, read
  back by `GET /requests/{id}/exchange`. One object, so a reader never sees the request of one
  attempt next to the reply of another. The function that reads it may list the bucket:
  without that, S3 answers a missing key with 403 and "no exchange yet" would look like an error.
- **Alarms treat missing data as fine, and the SNS topics are not KMS-encrypted.** An idle
  queue publishes no metric, and encrypted topics can only receive CloudWatch alarms through a
  customer-managed key. The messages hold ids and alarm data, never request text.

## Running bootstrap

```sh
cd bootstrap
cp terraform.tfvars.example terraform.tfvars     # then edit
cp backend.tfbackend.example backend.tfbackend   # then edit
terraform init -backend-config=backend.tfbackend
terraform apply
```

On an empty account the state bucket doesn't exist yet; the first-run steps are in the
comment at the top of `backend.tf`.
