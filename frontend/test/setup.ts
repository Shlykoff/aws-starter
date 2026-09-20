import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { configureMobx } from "@/shared/lib";

// Same MobX rule as the app (changes only inside actions), so a store that breaks it
// fails its test.
configureMobx();

// Testing Library only unmounts rendered components by itself when the test framework has
// global `afterEach`; Vitest does not by default, so do it here.
afterEach(() => {
  cleanup();
});
