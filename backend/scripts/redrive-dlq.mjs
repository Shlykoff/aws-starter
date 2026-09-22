#!/usr/bin/env node
// Operator CLI for the delivery dead-letter queue (docs/api.md, "Queue"). Run locally by the
// owner with their own AWS profile: no Lambda, no IAM role, no Terraform change. It never
// bundles into a handler (it is not in scripts/build.mjs's `functions` list) and is invoked
// with plain `node`, so it cannot import backend/src/ (TypeScript, needs a bundler). Instead it
// keeps its own tiny copies of pieces of domain logic that already live in
// src/domain/delivery-message.ts and src/domain/request-keys.ts: `MESSAGE_GROUP_ID`,
// `decodeDeliveryMessage`, `ownerKey`, `requestKey`. Each is exported here too, so
// test/scripts/redrive-dlq.test.ts can hold this copy against the real one and catch drift.
//
// The DLQ mixes two kinds of message (docs/api.md, "Known limits"):
//   - "error": our own infra hiccup (DynamoDB, S3, a bug) while handling an otherwise good
//     request. Worth redriving once the underlying problem is fixed.
//   - "undeliverable": a malformed message body, or a request that no longer exists. Never
//     worth redriving; it will fail the same way again.
// Nothing here can tell the two apart automatically, so there is no bulk "act on everything"
// flag: `redrive`/`discard` always name exactly one message id, and a human decides per message.

import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

// ---------------------------------------------------------------------------------------------
// Duplicated domain logic. Keep these in lockstep with src/domain/delivery-message.ts and
// src/domain/request-keys.ts (test/scripts/redrive-dlq.test.ts checks that they agree).
// ---------------------------------------------------------------------------------------------

const OWNER_PREFIX = "USER#";
const REQUEST_PREFIX = "REQ#";

/** Same as src/domain/request-keys.ts: ownerKey. */
export function ownerKey(ownerId) {
  return `${OWNER_PREFIX}${ownerId}`;
}

/** Same as src/domain/request-keys.ts: requestKey. */
export function requestKey(id) {
  return `${REQUEST_PREFIX}${id}`;
}

/** Same as src/domain/delivery-message.ts: MESSAGE_GROUP_ID (one fixed group; there is one recipient). */
export const MESSAGE_GROUP_ID = "requests";

/**
 * Same as src/domain/delivery-message.ts: decodeDeliveryMessage, minus the zod schema (this
 * script has no dependency on zod). `undefined` when the body is not JSON, or is JSON but does
 * not have non-empty string `requestId` and `ownerId` fields.
 */
export function decodeDeliveryMessage(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    json !== null &&
    typeof json === "object" &&
    typeof json.requestId === "string" &&
    json.requestId.length > 0 &&
    typeof json.ownerId === "string" &&
    json.ownerId.length > 0
  ) {
    return { requestId: json.requestId, ownerId: json.ownerId };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Environment. Fail fast, one clear message per missing variable, naming the exact command
// that produces it (run from infra/envs/dev; see infra/envs/dev/outputs.tf).
// ---------------------------------------------------------------------------------------------

const TERRAFORM_OUTPUTS = {
  TABLE_NAME: "table_name",
  QUEUE_URL: "queue_url",
  DLQ_URL: "dlq_url",
};

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    const output = TERRAFORM_OUTPUTS[name];
    throw new Error(`${name} is not set. Run: (cd infra/envs/dev && terraform output -raw ${output})`);
  }
  return value;
}

/** Reads TABLE_NAME, QUEUE_URL, DLQ_URL, AWS_REGION from the environment. Throws on the first missing one. */
export function loadConfig() {
  return {
    region: process.env.AWS_REGION ?? "eu-north-1",
    tableName: requireEnv("TABLE_NAME"),
    queueUrl: requireEnv("QUEUE_URL"),
    dlqUrl: requireEnv("DLQ_URL"),
  };
}

function buildClients({ region }) {
  return {
    sqs: new SQSClient({ region }),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers shared by the three commands.
// ---------------------------------------------------------------------------------------------

// Same receive on the DLQ for `list`, `redrive` and `discard`: up to 10 messages, 30 s of
// visibility (enough to read and act on a batch by hand), "All" so we get SentTimestamp,
// ApproximateReceiveCount and, when present, AWSTraceHeader.
async function receiveFromDlq(sqs, dlqUrl) {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: 10,
      VisibilityTimeout: 30,
      MessageSystemAttributeNames: ["All"],
    }),
  );
  return result.Messages ?? [];
}

async function findInBatch(sqs, dlqUrl, messageId) {
  const messages = await receiveFromDlq(sqs, dlqUrl);
  return messages.find((message) => message.MessageId === messageId);
}

async function getRequestItem(ddb, tableName, ownerId, requestId) {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: ownerKey(ownerId), sk: requestKey(requestId) },
    }),
  );
  return result.Item;
}

function ageSecondsFrom(sentTimestamp) {
  const sentMs = Number(sentTimestamp);
  if (!Number.isFinite(sentMs)) return "unknown";
  return `${Math.max(0, Math.round((Date.now() - sentMs) / 1000))}s`;
}

// Truncated to at most 60 characters: this prints to a terminal, not a log, but the request
// text still does not belong in full on screen (docs/api.md keeps it out of the queue itself).
function truncateSubject(subject) {
  return subject.length <= 60 ? subject : `${subject.slice(0, 59)}…`;
}

// Seen live: every command does its own receive, which hides what it sees for 30 s. Running
// `list` right before `redrive`/`discard` on the SAME message can hide it from that next
// command until the 30 s pass — "not found" there does not mean the message is gone, only that
// this call's own receive did not see it. Waiting a few seconds and trying again is the fix.
const NOT_FOUND_MESSAGE = "not found in this batch (or hidden by a receive from seconds ago) — wait a few seconds and run `list` again";

// ---------------------------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------------------------

/** Read-only: lists every message currently in the DLQ. Never sends or deletes anything. */
export async function list(sqs, ddb, { dlqUrl, tableName }) {
  const messages = await receiveFromDlq(sqs, dlqUrl);
  if (messages.length === 0) {
    console.log("DLQ is empty right now (or every message is already invisible to another reader).");
    return;
  }

  for (const message of messages) {
    const age = ageSecondsFrom(message.Attributes?.SentTimestamp);
    const decoded = decodeDeliveryMessage(message.Body ?? "");
    if (decoded === undefined) {
      console.log(`${message.MessageId}  age=${age}  not decodable — can only be discarded`);
      continue;
    }

    const item = await getRequestItem(ddb, tableName, decoded.ownerId, decoded.requestId);
    if (item === undefined) {
      console.log(
        `${message.MessageId}  requestId=${decoded.requestId}  age=${age}  request not found — can only be discarded`,
      );
      continue;
    }

    const subject = typeof item.subject === "string" ? ` subject="${truncateSubject(item.subject)}"` : "";
    console.log(
      `${message.MessageId}  requestId=${decoded.requestId}  senderEmail=${item.senderEmail}  status=${item.status}  age=${age}${subject}`,
    );
  }

  console.log("Nothing above was deleted or resent; anything not acted on becomes visible again in 30 seconds.");
}

/**
 * Resends one DLQ message to the delivery queue, then removes it from the DLQ (only after the
 * send succeeds). Exits 1 without deleting when the message cannot be identified, decoded, or
 * matched to a request; exits 1 without deleting when the send itself fails.
 */
export async function redrive(sqs, ddb, { dlqUrl, queueUrl, tableName }, messageId) {
  const message = await findInBatch(sqs, dlqUrl, messageId);
  if (message === undefined) {
    console.error(NOT_FOUND_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const decoded = decodeDeliveryMessage(message.Body ?? "");
  if (decoded === undefined) {
    console.error("malformed — use `discard`");
    process.exitCode = 1;
    return;
  }

  const item = await getRequestItem(ddb, tableName, decoded.ownerId, decoded.requestId);
  if (item === undefined) {
    console.error("the request no longer exists — use `discard`");
    process.exitCode = 1;
    return;
  }

  const groupId = MESSAGE_GROUP_ID;
  // A FRESH deduplication id, never `${requestId}` (the first-send shape) or
  // `${requestId}-r<n>` (the retry shape) that src/domain/delivery-message.ts already uses: SQS
  // drops a message whose deduplication id it has seen in the last 5 minutes, so reusing either
  // shape could make a redrive silently vanish as a "duplicate" of an old send. Stamping the
  // current time makes that collision impossible.
  const deduplicationId = `${decoded.requestId}-redrive-${Date.now()}`;
  const traceHeader = message.Attributes?.AWSTraceHeader;

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: message.Body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
        // Same shape as src/repositories/sqs-delivery-queue.ts: a SYSTEM attribute, only sent
        // when the DLQ message actually carried one.
        ...(traceHeader !== undefined && {
          MessageSystemAttributes: { AWSTraceHeader: { DataType: "String", StringValue: traceHeader } },
        }),
      }),
    );
  } catch (error) {
    // Nothing is lost: the message is still in the DLQ and becomes visible again after the
    // receive's visibility timeout, so it is safe to just report the failure and stop.
    console.error(`send failed, message left in the DLQ: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  // Only reached after a successful send: delete the DLQ copy with THIS receive's handle.
  await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: message.ReceiptHandle }));
  console.log(`redriven ${messageId} (requestId=${decoded.requestId}) with deduplicationId=${deduplicationId}`);
}

/** Deletes one DLQ message for good, without resending it. Never touches the delivery queue. */
export async function discard(sqs, { dlqUrl }, messageId) {
  const message = await findInBatch(sqs, dlqUrl, messageId);
  if (message === undefined) {
    console.error(NOT_FOUND_MESSAGE);
    process.exitCode = 1;
    return;
  }

  await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: message.ReceiptHandle }));
  console.log(`discarded ${messageId}`);
}

// ---------------------------------------------------------------------------------------------
// CLI entry.
// ---------------------------------------------------------------------------------------------

export function printUsage() {
  console.error(`Usage: node backend/scripts/redrive-dlq.mjs [command] [messageId]

Commands:
  list                 Show what is in the DLQ right now (read-only, safe to run any time).
                        This is also the default when no command is given.
  redrive <messageId>  Resend one DLQ message to the delivery queue, then remove it from the DLQ.
                        Use for an "error" outcome (our own infra hiccup) once it is fixed.
  discard <messageId>  Remove one DLQ message for good, without resending it.
                        Use for an "undeliverable" outcome (malformed body, or the request is gone).

Environment:
  TABLE_NAME   the requests table name    -> (cd infra/envs/dev && terraform output -raw table_name)
  QUEUE_URL    the delivery queue URL     -> (cd infra/envs/dev && terraform output -raw queue_url)
  DLQ_URL      the dead-letter queue URL  -> (cd infra/envs/dev && terraform output -raw dlq_url)
  AWS_REGION   defaults to eu-north-1
`);
}

/** The CLI: parses argv, wires real AWS clients from the environment, and runs one command. */
export async function main(argv = process.argv.slice(2)) {
  const [command, messageId] = argv;

  if (command === undefined || command === "list") {
    const config = loadConfig();
    const { sqs, ddb } = buildClients(config);
    await list(sqs, ddb, config);
    return;
  }

  if (command === "redrive" || command === "discard") {
    if (messageId === undefined) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const config = loadConfig();
    const { sqs, ddb } = buildClients(config);
    if (command === "redrive") {
      await redrive(sqs, ddb, config, messageId);
    } else {
      await discard(sqs, config, messageId);
    }
    return;
  }

  printUsage();
  process.exitCode = 1;
}

// Runs the CLI only when this file is executed directly (`node redrive-dlq.mjs ...`), not when
// it is imported by the test suite.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
