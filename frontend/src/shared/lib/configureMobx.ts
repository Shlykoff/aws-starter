import { configure } from "mobx";

// "always": an observable may only be changed inside an action. A change made anywhere
// else (a component, a timer callback, code after an `await`) logs a MobX warning, so
// mistakes show up in development instead of as views that silently do not update.
// Called once at startup, and again by the test setup so tests run under the same rule.
export function configureMobx(): void {
  configure({ enforceActions: "always" });
}
