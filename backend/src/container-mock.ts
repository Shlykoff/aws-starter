import { Container } from "inversify";
import { bindLogger } from "./container-shared";
import { loadMockConfig } from "./lib/config";

// The dependency graph of the partner-mock function: a logger and nothing else. The mock
// needs no environment variable except the optional LOG_LEVEL, no AWS client and no
// permission. It still goes through a container, so all six functions start the same way.
const config = loadMockConfig(process.env);

export const container = new Container();

bindLogger(container, config.logLevel);
