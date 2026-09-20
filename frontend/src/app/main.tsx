import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadConfig } from "@/shared/config";
import { configureMobx } from "@/shared/lib";
import "./styles/globals.css";
import { App } from "./App";
import { ConfigErrorScreen } from "./ConfigErrorScreen";
import { createRootStore } from "./providers/root-store";
import { createAppRouter } from "./router";

configureMobx();

const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root element");
const root = createRoot(container);

const config = loadConfig();
if (!config.ok) {
  // A missing variable is a setup mistake: say which one instead of showing a blank page.
  root.render(<ConfigErrorScreen problems={config.problems} />);
} else {
  const stores = createRootStore(config.config);
  // Look for a session left in sessionStorage (e.g. after a reload). Until it answers,
  // the route guard shows a loading state.
  void stores.auth.init();
  root.render(
    <StrictMode>
      <App stores={stores} router={createAppRouter()} />
    </StrictMode>,
  );
}
