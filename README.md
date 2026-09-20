# aws-starter

A small reference project for running serverless services on AWS: Terraform for
infrastructure, Node.js + TypeScript on Lambda, a React frontend. It is built
around a demo scenario, sending requests to a partner system, that has two paths:

- **User path**: React -> API Gateway -> Lambda -> DynamoDB, authenticated with Cognito.
- **Delivery path**: a request is queued in SQS FIFO; a worker Lambda builds an XML
  message, validates it against an XSD and posts it to a webhook. Status changes
  are published to SNS, messages that keep failing land in a DLQ.

All data is fake. The domain is deliberately neutral.

## Status

- [x] Stage 0: bootstrap (state bucket, budget alert, GitHub OIDC role)
- [ ] Stage 1: REST API (API Gateway, Lambda, DynamoDB), Cognito, React login + list/form, CI/CD.
  Deployed and smoke-tested: API, Lambdas, DynamoDB, Cognito, static hosting. Pending:
  React app, CI/CD.
- [ ] Stage 2: async delivery (SQS FIFO, worker, DLQ, SNS), S3 for files
- [ ] Stage 3: XML + XSD validation, PII masking in logs, CloudWatch/X-Ray, secrets in SSM, tests

## Layout

```
bootstrap/   one-off Terraform: state bucket, budget, GitHub OIDC role
infra/       main Terraform stack (remote state), modules per service   [stage 1]
backend/     Node.js + TypeScript Lambda handlers                        [stage 1]
frontend/    React app                                                   [stage 1]
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
  -> `queued` (in SQS FIFO) -> `sent` (partner answered 2xx). `failed` means delivery
  retries are exhausted and the message is in the DLQ; `rejected` means the XML failed
  schema validation and is not retried. Stage 1 only ever sets `created`.
- **HTTP API instead of REST API.** Cheaper, lower latency and it has a built-in JWT
  authorizer, so no authorizer Lambda is needed. The REST-only features (API keys,
  usage plans, request validation) are not needed here.
- **Cognito: Essentials tier with the classic hosted UI** instead of managed login. The
  classic UI covers login, logout and password reset, and managed login needs an extra
  branding resource before it renders anything.

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
