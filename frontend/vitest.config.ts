import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

// Reuses vite.config.ts (React plugin, the `@` alias) and adds the test settings.
export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      // Test helpers (fakes, factories) live in test/, outside the FSD layers.
      alias: { "@test": fileURLToPath(new URL("./test", import.meta.url)) },
    },
    test: {
      include: ["src/**/*.test.{ts,tsx}"],
      // The DOM the components render into. No browser, no network.
      environment: "jsdom",
      // Adds the jest-dom matchers (toBeInTheDocument, ...) and configures MobX.
      setupFiles: ["./test/setup.ts"],
      // Put mocks and spies back to the originals after every test.
      restoreMocks: true,
    },
  }),
);
