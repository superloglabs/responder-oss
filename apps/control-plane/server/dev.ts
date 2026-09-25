import { serve } from "@hono/node-server";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Local environment files are optional for the health route and UI development.
}

const { initializeServerMonitoring } = await import("./monitoring.js");
initializeServerMonitoring();

const { app } = await import("./app.js");
const { startScanScheduler } = await import("./scans/scheduler.js");
startScanScheduler();
const { startAutomationScheduler } = await import("./automations/scheduler.js");
startAutomationScheduler();

serve(
  {
    fetch: app.fetch,
    port: Number(process.env.CONTROL_PLANE_API_PORT ?? 8787),
  },
  ({ port }) => {
    console.log(`Hono API listening on http://localhost:${port}`);
  },
);
