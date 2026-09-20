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

// ---- API functions: create-request, list-requests, get-request ----

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

// ---- delivery-worker ----

export interface WorkerConfig {
  tableName: string;
  partnerUrl: string;
  topicArn: string;
  auditBucket: string;
  /** Must equal the `maxReceiveCount` of the queue's redrive policy (both come from Terraform). */
  maxReceiveCount: number;
  /** The region of the function; the request to the partner is signed for it. */
  region: string;
  logLevel: LogLevel;
}

const workerSchema = z.object({
  TABLE_NAME: requiredString,
  PARTNER_URL: requiredUrl,
  TOPIC_ARN: requiredString,
  AUDIT_BUCKET: requiredString,
  MAX_RECEIVE_COUNT: positiveInteger,
  // Set by the Lambda runtime in every function, so it needs no Terraform. The worker needs
  // it explicitly because it signs a request by hand (the SDK clients read it themselves).
  AWS_REGION: requiredString,
  LOG_LEVEL: logLevel,
});

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const values = parseEnvironment(workerSchema, env);
  return {
    tableName: values.TABLE_NAME,
    partnerUrl: values.PARTNER_URL,
    topicArn: values.TOPIC_ARN,
    auditBucket: values.AUDIT_BUCKET,
    maxReceiveCount: values.MAX_RECEIVE_COUNT,
    region: values.AWS_REGION,
    logLevel: values.LOG_LEVEL,
  };
}

// ---- partner-mock ----

export interface MockConfig {
  logLevel: LogLevel;
}

const mockSchema = z.object({ LOG_LEVEL: logLevel });

/** The mock needs nothing but the log level. */
export function loadMockConfig(env: Record<string, string | undefined>): MockConfig {
  return { logLevel: parseEnvironment(mockSchema, env).LOG_LEVEL };
}
