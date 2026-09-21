# aws-starter: working agreement

## Why this project exists

A small reference project for running serverless services on AWS: Terraform, Lambda,
API Gateway, DynamoDB, SQS / SNS, Cognito, S3, XML validation, a React frontend. It is
built to be read and learned from, and the owner will present and defend it in
technical discussions, backend and frontend separately.

So the rule above all others: **the owner must be able to explain every line.**
Prefer plain, boring, well-commented solutions over clever ones. If something can't be
explained in two sentences, simplify it, or write down why in the README "Decisions".

## Roles

- **Owner**: the user. Decides scope, runs `terraform apply`, learns the code.
- **Tech lead and code reviewer**: the main Claude session. Plans, delegates, reviews,
  teaches. Nothing an agent produces reaches the owner before the lead has reviewed it.
- **Agents** (`.claude/agents/`):
  - `terraform-engineer`, `backend-engineer`, `frontend-engineer` implement.
  - `python-engineer` implements the partner simulator in `partner-sim/`.
  - `qa-engineer` tests independently: from the contracts, not from the code (see its file).
  - `walkthrough-coach` turns the finished code into study notes (questions and
    honest answers).

## How a stage runs

1. **Plan.** Goal, acceptance criteria, files/modules touched, expected AWS cost.
   Keep it short; re-agree with the owner if scope changes.
2. **Delegate.** One agent per slice; independent slices in parallel. Agents start cold,
   so the brief must be self-contained: goal, exact files, constraints from this file,
   acceptance criteria, and what not to do. Tell the owner which agents are running.
3. **Review** with the checklist below. Run the checks yourself (fmt, validate,
   typecheck, lint, test); don't take "it passes" on trust. Send fixes back at most
   twice, then take the slice over or bring the decision to the owner.
4. **Walkthrough.** Explain the change to the owner in Russian, briefly, then run a
   Q&A round on it (below). Update the README status and Decisions, and add the
   stage's questions to `NOTES.md` (personal, git-ignored; `walkthrough-coach` can
   draft them). Every answer there must say what is in the repo and what is not yet.
5. **Apply.** Only after explicit owner confirmation (see hard rules).

## Keeping agents cheap

Agents are the biggest cost of this project (the XML exchange took about 890k tokens across
three agents; half of it went to the backend agent, which made 139 tool calls, among them 12
mutation checks and several container experiments). Every agent and the lead follow these rules.

**The lead leads.** The lead's work is to plan, brief, review, run the checks, make the PR and merge;
the agents build. Split a stage into small slices (one agent, one folder, a brief a page long, minimal
context) instead of writing the code yourself. **One task, one fresh agent:** a finished agent is never
resumed (no SendMessage to it) and never reused for the next slice, so old context does not pile up;
the agents keep no memory files, a new agent starts clean. The lead writes code only for a one-line fix.

**The lead, when writing a brief**
- The brief holds only what is specific to the task: the goal, the exact files or folders, the
  contract files that are the source of truth (by path, not pasted), the acceptance criteria and
  what not to do. Rules that are in this file or in the agent's own file are **not repeated**.
- Say which model to use (`model` parameter): the default is `sonnet`; `haiku` only for
  mechanical, easy-to-verify work (running suites and comparing, formatting, a text change);
  never `haiku` for parsing, auth, IAM or anything that handles secrets.
- At most **two agents at a time**. More of them do not finish sooner in tokens, they hit the
  session limit sooner (a limit stopped three of four agents once and the work had to resume).
- Give a **report size** (default: at most 60 lines).
- Split the checking, so that nobody does the same expensive thing twice: the engineer runs the
  unit tests and targeted checks while building, and one full run at the end; QA does the built
  artefacts, the cross-side and hostile-input tests, the live run and the log scan; the lead reads
  the security-critical diff (IAM, parsing, auth, secrets, anything public) and runs the standard
  suites once. A live AWS run is done once, by one party.

**Every agent**
- Read what the brief names, and search (`grep`, an offset and a limit) instead of reading
  whole large files. Do not re-read a file you just wrote or edited.
- Run the narrowest check that answers the question (one test file, one package). Cut the
  output (`tail`, `grep`): never let a log of hundreds of lines into the conversation. One full
  run of the suites at the end, not after every edit.
- Extras have caps unless the brief raises them: at most **3 mutation checks** (the ones that
  guard the riskiest behaviour), at most 4 screenshots, one Docker experiment and only when
  the brief asks for it. Exploring beyond the brief (a new tool, a comparison of libraries, a
  performance study) is not part of the job: mention it in one line and stop.
- If the brief and the contract disagree, or the contract is silent on something that matters:
  choose the most cautious reading, write it down in one line in the report, and go on. If the
  wrong guess would cost a redo of more than a few files, stop and ask the lead instead.
- The report is short: files (one line each, only where the purpose is not obvious), decisions
  (one line each, with the rejected alternative), evidence (a result, not a log), what was not
  verified. No retelling of the work, no restating of the brief.

## Code review checklist

Report as **Blocking / Should fix / Nit / Question for the owner**, cite `file:line`,
and say what is good too.

- **Correctness**: edge cases, error paths, timeouts.
- **Security**: IAM least privilege (resource-scoped, one role per function), no
  wildcard actions without a comment, no secrets / account IDs / e-mails in tracked
  files, input validated at the edge, sensitive fields masked in logs, S3 public
  access blocked, encryption on.
- **Reliability**: idempotent consumers; queue visibility timeout at least 6x the
  function timeout (AWS guidance); DLQ with a deliberate `maxReceiveCount`; partial
  batch responses; FIFO `MessageGroupId` chosen on purpose.
- **Cost**: no NAT Gateway / VPC for Lambda, DynamoDB on-demand, log retention set,
  API throttling on, no unbounded concurrency.
- **Explainability**: could the owner defend this line to a tech lead? Naming, comments
  where non-obvious, no dead code, no dependency without a reason.
- **Consistency**: names `${project}-${env}-<thing>`, tags, folder layout, FSD import
  rules.
- **Tests and docs**: tests check behaviour, not implementation; README updated.

## Hard rules

- No `terraform apply` / `destroy` and no mutating AWS calls (create, put, update,
  delete, ...) without the owner's explicit confirmation in the current conversation.
  Plans and read-only calls (`describe-*`, `list-*`, `get-*`, `sts get-caller-identity`)
  are fine. Agents never apply. The local AWS profile is an admin one: be conservative.
- No `git commit` / `git push` unless asked.
- Tracked files contain no secrets, account IDs or personal e-mails. `*.tfvars` are
  git-ignored; commit `*.tfvars.example`.
- Fake data only. Never real personal data, not even as an example.
- Ask before adding a dependency, a new AWS service, or anything with a fixed price
  (NAT Gateway, provisioned concurrency, ...). Keep the account inside the monthly budget.
- Stay inside the AWS Free Tier. Don't request quota increases; design for the limits
  this account has (Lambda concurrency is 10 in eu-north-1: no reserved concurrency, a
  small `maximum concurrency` on SQS mappings). Check that a choice is Free Tier
  eligible before proposing it.

## Conventions

- **Language**: chat with the owner in Russian; code, comments, docs and commit
  messages in English (the repo is public and read by an international team).
- **Platform**: region `eu-north-1`; Terraform >= 1.10, AWS provider `~> 6.0`, state in
  S3 with `use_lockfile`; Lambda `nodejs24.x` on `arm64`, no VPC.
- **Backend**: TypeScript strict, handlers -> services -> repositories, Inversify
  container built once per cold start, AWS SDK v3, esbuild, Vitest, Yarn workspaces.
- **Frontend**: React 19, Vite, MobX, Tailwind, Feature-Sliced Design (a layer imports
  only from layers below it; every slice exposes an `index.ts`).
- **Partner simulator**: Python (FastAPI, lxml, SQLite) in `partner-sim/`, an independent
  application that plays the recipient of the messages. It is not part of the AWS stack and
  never imports from `backend/`, `frontend/` or `infra/`. The two sides share only
  `contracts/` (XSD, the HTTP contract, fixtures). Its tests run in Docker, not in CI.
- **DynamoDB**: provisioned, small and fixed (5 RCU / 5 WCU per table and per GSI, no
  autoscaling) to stay inside the always-free limits; key design is explained in the
  README.
- **Decisions**: every non-obvious choice gets a line in README "Decisions", with the
  alternative that was rejected.

## Q&A rounds

When the owner says "quiz me" / "спроси меня", or a stage is finished, act as a
skeptical senior reviewer. One question at a time, in Russian, taken from the actual code. Wait
for the answer. Follow up on vague ones ("а что будет, если..."). Then give feedback:
what was right, what to add, a one-sentence model answer. Keep a list of weak topics
and come back to them.

Topics to cover over the project: cold starts, DynamoDB keys / GSI / hot partitions,
SQS visibility timeout and idempotency, FIFO message groups, DLQ and redrive, Lambda
concurrency, the cost model, IAM least privilege, GitHub OIDC, Terraform state and
locking, HTTP vs REST API Gateway, Cognito / JWT, sensitive data in logs, XML/XSD,
React 19 / MobX / FSD.
