import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Feature-Sliced Design: the layers, from top to bottom. A layer may import only from
// layers BELOW it. `app` and `shared` have no slices; the other four are split into slices
// (one folder per feature/page/...) that must not know about each other.
const LAYERS = ["app", "pages", "widgets", "features", "entities", "shared"];
const SLICED_LAYERS = ["pages", "widgets", "features", "entities"];

// FSD boundaries are enforced with ESLint's built-in `no-restricted-imports`, so no extra
// plugin is needed. Files of each layer get their own list of forbidden import patterns:
//   1. no imports from a layer above (`@/features/...` inside `src/entities`);
//   2. no imports from another slice of the same layer (`@/features/x` inside `src/features`):
//      a slice uses relative paths for its own files, so any `@/<own layer>` import is a
//      sibling slice;
//   3. no reaching into a slice of a lower layer (`@/entities/request/model/...`): import
//      its public API (`@/entities/request`, i.e. its index.ts);
//   4. no climbing out of a slice with `../../` (that would bypass 2 and 3).
// The rules apply to imports written with the `@/` alias, which is how the code crosses
// slice and layer boundaries; a stray relative import is caught by rule 4.
function boundaryPatterns(layer) {
  const position = LAYERS.indexOf(layer);
  const patterns = [];

  for (const upper of LAYERS.slice(0, position)) {
    patterns.push({
      group: [`@/${upper}`, `@/${upper}/**`],
      message: `The ${layer} layer may not import from the ${upper} layer: imports go downward only.`,
    });
  }
  if (SLICED_LAYERS.includes(layer)) {
    patterns.push({
      group: [`@/${layer}`, `@/${layer}/**`],
      message: `Slices of the ${layer} layer may not import each other. Move the shared part down a layer.`,
    });
    patterns.push({
      group: ["../../**"],
      message: "Do not climb out of a slice with relative paths; import from a lower layer with the @/ alias.",
    });
  }
  for (const lower of LAYERS.slice(position + 1).filter((name) => SLICED_LAYERS.includes(name))) {
    patterns.push({
      group: [`@/${lower}/*/**`],
      message: `Import slices of the ${lower} layer through their public API (@/${lower}/<slice>), not their internals.`,
    });
  }
  return patterns;
}

export default defineConfig(
  { ignores: ["dist/**", "coverage/**"] },

  // typescript-eslint's "recommended, type-checked" rule set: the type-aware part catches
  // un-awaited promises, which matter in async store code.
  tseslint.configs.recommendedTypeChecked,
  // Rules of hooks (call order) and exhaustive effect dependencies.
  reactHooks.configs.flat["recommended-latest"],
  {
    languageOptions: {
      // Let typescript-eslint find tsconfig.json by itself for every linted file.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-console": "error",
    },
  },

  // One block per layer with its own FSD import restrictions (see boundaryPatterns).
  ...LAYERS.map((layer) => ({
    files: [`src/${layer}/**/*.{ts,tsx}`],
    rules: { "no-restricted-imports": ["error", { patterns: boundaryPatterns(layer) }] },
  })),

  // Plain JavaScript files (this config) are not part of the TypeScript project, so the
  // rules that need type information cannot run on them.
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
);
