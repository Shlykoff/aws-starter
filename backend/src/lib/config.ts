import { z } from "zod";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// The environment variables of the Lambda contract in docs/api.md ("Lambda contract").
// Every function validates ONLY its own variables: an API function does not need a queue
// URL, and must not fail to start because one is missing. Each function's container
// (src/container*.ts) calls exactly one of the load functions below, once, at cold start.

const logLevel = z.enum(LOG_LEVELS).default("info");

const requiredString = z.string({ error: "is required" }).min(1, "must not be empty");

const requiredUrl = requiredString.refine((value) => URL.canParse(value), "must be a valid URL");

// Environment variables are always strings, so a number is checked as text first. Only
// plain digits without a leading zero pass: no "0", "-1", "2.5", "3 " or "1e3".
const positiveInteger = z
  .string({ error: "is required" })
  .regex(/^[1-9]\d*$/, "must be a positive integer")
  .transform(Number);

function parseEnvironment<T>(schema: z.ZodType<T>, env: Record<string, string | undefined>): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".")} ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return result.data;
}

// ---- API functions: create-request, list-requests, get-request, retry-request ----

export interface Config {
  tableName: string;
  logLevel: LogLevel;
}

const apiSchema = z.object({ TABLE_NAME: requiredString, LOG_LEVEL: logLevel });

/**
 * Reads and validates the configuration of the API functions. It throws with a readable
 * message when something is wrong. It is called once at cold start (src/container.ts), so
 * a misconfigured function fails while it initialises, not on the first customer request.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const values = parseEnvironment(apiSchema, env);
  return { tableName: values.TABLE_NAME, logLevel: values.LOG_LEVEL };
}

// ---- enqueuer ----

export interface EnqueuerConfig {
  tableName: string;
  queueUrl: string;
  logLevel: LogLevel;
}

const enqueuerSchema = z.object({
  TABLE_NAME: requiredString,
  QUEUE_URL: requiredUrl,
  LOG_LEVEL: logLevel,
});

export function loadEnqueuerConfig(env: Record<string, string | undefined>): EnqueuerConfig {
  const values = parseEnvironment(enqueuerSchema, env);
  return { tableName: values.TABLE_NAME, queueUrl: values.QUEUE_URL, logLevel: values.LOG_LEVEL };
}

// ---- get-exchange ----

export interface ExchangeConfig {
  tableName: string;
  /** The bucket of the exchange records (its variable is called AUDIT_BUCKET in docs/api.md). */
  auditBucket: string;
  logLevel: LogLevel;
}

const getExchangeSchema = z.object({
  TABLE_NAME: requiredString,
  AUDIT_BUCKET: requiredString,
  LOG_LEVEL: logLevel,
});

export function loadExchangeConfig(env: Record<string, string | undefined>): ExchangeConfig {
  const values = parseEnvironment(getExchangeSchema, env);
  return { tableName: values.TABLE_NAME, auditBucket: values.AUDIT_BUCKET, logLevel: values.LOG_LEVEL };
}

// ---- delivery-worker ----

export interface WorkerConfig {
  tableName: string;
  /** The recipient's address: scheme, host and port only. The client adds the path. */
  partnerUrl: string;
  /** The name of the SSM parameter (SecureString) that holds the recipient's API key. */
  partnerApiKeyParam: string;
  topicArn: string;
  auditBucket: string;
  /** Must equal the `maxReceiveCount` of the queue's redrive policy (both come from Terraform). */
  maxReceiveCount: number;
  logLevel: LogLevel;
}

// Hosts that mean "this same machine". Plain http is allowed for them and for nothing else.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

// The base address of the recipient. The API key travels in a header, so the address must
// be https. The one exception is a recipient on this very machine: it lets the local
// integration test talk to partner-sim over plain http, and nothing leaves the computer.
// The URL must be just scheme, host and port, because the client adds the path itself: a
// path, a query, a fragment or credentials (https://user:pass@host) would be a mistake, and
// would be silently thrown away or misused later. The one comparison below rules them all
// out: `href` is the whole normalised URL, and `origin` is scheme + host + port.
function isPartnerBaseUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.href !== `${url.origin}/`) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname));
}

const partnerUrl = requiredString.refine(
  isPartnerBaseUrl,
  "must be an https URL made of host and port only, like https://partner.example.com (http is allowed only for localhost)",
);

const workerSchema = z.object({
  TABLE_NAME: requiredString,
  PARTNER_URL: partnerUrl,
  PARTNER_API_KEY_PARAM: requiredString,
  TOPIC_ARN: requiredString,
  AUDIT_BUCKET: requiredString,
  MAX_RECEIVE_COUNT: positiveInteger,
  LOG_LEVEL: logLevel,
});

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const values = parseEnvironment(workerSchema, env);
  return {
    tableName: values.TABLE_NAME,
    partnerUrl: values.PARTNER_URL,
    partnerApiKeyParam: values.PARTNER_API_KEY_PARAM,
    topicArn: values.TOPIC_ARN,
    auditBucket: values.AUDIT_BUCKET,
    maxReceiveCount: values.MAX_RECEIVE_COUNT,
    logLevel: values.LOG_LEVEL,
  };
}

// ---- receive-webhook ----

export interface WebhookConfig {
  tableName: string;
  /** The name of the SSM parameter (SecureString) that holds the token that signs the webhook. */
  webhookTokenParam: string;
  logLevel: LogLevel;
}

const webhookSchema = z.object({
  TABLE_NAME: requiredString,
  WEBHOOK_TOKEN_PARAM: requiredString,
  LOG_LEVEL: logLevel,
});

export function loadWebhookConfig(env: Record<string, string | undefined>): WebhookConfig {
  const values = parseEnvironment(webhookSchema, env);
  return {
    tableName: values.TABLE_NAME,
    webhookTokenParam: values.WEBHOOK_TOKEN_PARAM,
    logLevel: values.LOG_LEVEL,
  };
}

// ---- log-archiver ----

export interface ArchiverConfig {
  /** The bucket that receives the archived log batches (`logs/year=.../...json.gz`). */
  archiveBucket: string;
  logLevel: LogLevel;
}

const archiverSchema = z.object({ ARCHIVE_BUCKET: requiredString, LOG_LEVEL: logLevel });

export function loadArchiverConfig(env: Record<string, string | undefined>): ArchiverConfig {
  const values = parseEnvironment(archiverSchema, env);
  return { archiveBucket: values.ARCHIVE_BUCKET, logLevel: values.LOG_LEVEL };
}
