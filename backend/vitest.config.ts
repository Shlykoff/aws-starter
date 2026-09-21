import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The src/container*.ts files read their configuration when they are first imported
    // (like a Lambda cold start), so the handler tests need the environment variables to
    // exist before the import. The values are only labels: no test talks to a real table,
    // queue, topic, bucket, parameter or partner, and no test has AWS credentials.
    env: {
      TABLE_NAME: "test-requests",
      QUEUE_URL: "https://sqs.eu-north-1.amazonaws.com/000000000000/test-deliveries.fifo",
      PARTNER_URL: "https://partner.example.test/",
      PARTNER_API_KEY_PARAM: "/test/partner-api-key",
      WEBHOOK_TOKEN_PARAM: "/test/webhook-token",
      TOPIC_ARN: "arn:aws:sns:eu-north-1:000000000000:test-request-status",
      AUDIT_BUCKET: "test-deliveries",
      MAX_RECEIVE_COUNT: "5",
      AWS_REGION: "eu-north-1",
      // A log call the guard would have to change fails the test (lib/logger.ts, log-fields.ts).
      LOG_STRICT: "1",
    },
    // Put console.* and other spies back to the originals after every test.
    restoreMocks: true,
  },
});
