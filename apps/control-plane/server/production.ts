import { serve } from "@hono/node-server";
import { loadResponderSecrets } from "@responder/core/secrets";

loadResponderSecrets();

const { flushServerMonitoring, initializeServerMonitoring } = await import(
  "./monitoring.js"
);
initializeServerMonitoring();

const { productionApp } = await import("./production-app.js");
const { closeInvestigationQueue } = await import("./investigations/queue.js");

const port = Number(
  process.env.PORT ?? process.env.CONTROL_PLANE_API_PORT ?? 3000,
);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const server = serve(
  {
    fetch: productionApp.fetch,
    hostname: process.env.HOST ?? "0.0.0.0",
    port,
  },
  ({ address, port: listeningPort }) => {
    console.info(
      JSON.stringify({
        address,
        event: "control_plane_listening",
        port: listeningPort,
      }),
    );
  },
);

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ event: "control_plane_shutdown", signal }));

  const timeout = setTimeout(() => {
    console.error(JSON.stringify({ event: "control_plane_shutdown_timeout" }));
    process.exit(1);
  }, 25_000);
  timeout.unref();

  server.close(async (error) => {
    clearTimeout(timeout);
    if (error) {
      console.error(
        JSON.stringify({
          event: "control_plane_shutdown_error",
          errorCode: error.constructor.name,
        }),
      );
      process.exitCode = 1;
    }
    await closeInvestigationQueue().catch((queueError: unknown) => {
      console.error(
        JSON.stringify({
          event: "control_plane_queue_shutdown_error",
          errorCode:
            queueError instanceof Error
              ? queueError.constructor.name
              : "unknown",
        }),
      );
      process.exitCode = 1;
    });
    await flushServerMonitoring();
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
