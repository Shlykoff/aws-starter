import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // src/container.ts reads its configuration when it is first imported (like a Lambda
    // cold start), so the handler tests need TABLE_NAME to exist before the import.
    // The value is only a label: no test talks to a real table.
    env: { TABLE_NAME: "test-requests" },
    // Put console.* and other spies back to the originals after every test.
    restoreMocks: true,
  },
});
