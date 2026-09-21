# Contracts

What the two sides agree on, as files. Each side implements it on its own; neither imports the
other's code. This folder is the only thing they share.

```
xsd/
  common-types.xsd   shared types (ULID, UUID, party name, bounded text); no elements
  submission.xsd     the message the sender delivers (imports common-types.xsd)
  reply.xsd          the recipient's answer (imports common-types.xsd)
partner-api.md       the HTTP contract of the recipient
fixtures/
  submission/{valid,invalid}/*.xml    sample messages
  reply/{valid,invalid}/*.xml         sample answers
  expected.json                       what each sample must produce
```

## Who checks what

| Check | By | With what |
|---|---|---|
| The message we are about to send | the sender | `submission.xsd`, before sending |
| The message that arrived | the recipient | `submission.xsd`, on receipt |
| The answer that came back | the sender | `reply.xsd`, plus the rule that `Code` and `Description` appear exactly when the status is `Rejected` (XSD 1.0 cannot say this) |

## Rules for changing a schema

- **A published version never changes.** `v1` stays as it is. A different shape is a new
  namespace (`...:v2`) in new files, and the recipient may serve both for a while.
- The namespace URNs are identifiers, not addresses: nothing is fetched from them. Imports are
  resolved from the files next to the schema, never from the network.
- Every schema change comes with fixtures, and `expected.json` says what each fixture must do.
  **Both sides' tests run every fixture listed there**, so a disagreement between two
  implementations shows up as a failing test, not in production.

## `expected.json`

Maps each fixture to the outcome the recipient must produce:

| Value | Meaning | HTTP status of the answer |
|---|---|---|
| `valid` | accepted | `200` |
| `SCHEMA_INVALID` | well-formed but violates the schema | `422` |
| `MALFORMED_XML` | not well-formed, or carries a DOCTYPE | `400` |

For reply fixtures only `valid` and `SCHEMA_INVALID` occur.

## Checking a file by hand

`xmllint` (libxml2) is on most machines:

```sh
xmllint --noout --nonet --schema contracts/xsd/submission.xsd contracts/fixtures/submission/valid/minimal.xml
```

Exit code 0 is valid, 1 is not well-formed, 3 violates the schema. The two `doctype-*` fixtures
are refused by the recipient's policy, not by the schema, so `xmllint` is not the judge of those.
