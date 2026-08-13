import { serve } from "@hono/node-server";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Local environment files are optional for the health route and UI development.
}

const { initializeServerMonitoring } = await import("./monitoring.js");
initializeServerMonitoring();

const { app } = await import("./app.js");

serve(
  {
    fetch: app.fetch,
    port: Number(process.env.CONTROL_PLANE_API_PORT ?? 8787),
  },
  ({ port }) => {
    console.log(`Hono API listening on http://localhost:${port}`);
  },
);
