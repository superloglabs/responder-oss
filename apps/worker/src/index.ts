// Secrets and monitoring start before the worker's modules load, so that
// Postgres and the other instrumented libraries are patched when imported.
import { loadResponderSecrets } from "@responder/core/secrets";
import { initializeErrorMonitoring } from "./monitoring.js";

loadResponderSecrets();
initializeErrorMonitoring();

await import("./worker.js");
