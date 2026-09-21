import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/**", "coverage/**"] },

  // typescript-eslint's "recommended, type-checked" rule set. The type-aware part is what
  // catches un-awaited promises, which matter a lot in async Lambda code.
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // Let typescript-eslint find tsconfig.json by itself for every linted file.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      eqeqeq: ["error", "always"],
    },
  },

  // Application code logs through src/lib/logger.ts only (structured JSON, one place
  // that decides what is written). A stray console.log would bypass that.
  { files: ["src/**/*.ts"], rules: { "no-console": "error" } },
  { files: ["src/lib/logger.ts", "src/lib/metrics.ts"], rules: { "no-console": "off" } },

  // Plain JavaScript files (this config, the build script) are not part of the
  // TypeScript project, so the rules that need type information cannot run on them.
  { files: ["**/*.mjs"], extends: [tseslint.configs.disableTypeChecked] },
);
