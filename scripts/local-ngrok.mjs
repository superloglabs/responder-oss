import { spawn } from "node:child_process";
import { createServer, get } from "node:http";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";

const host = "127.0.0.1";
const controlPort = Number(process.env.RESPONDER_NGROK_CONTROL_PORT ?? 4101);
const routerPort = Number(process.env.RESPONDER_CALLBACK_BRIDGE_PORT ?? 4100);
const routerUrl = `http://127.0.0.1:${routerPort}`;
const relayMarker = "responder-local-ngrok-v1";
const monitorInterval = Number(
  process.env.RESPONDER_NGROK_POLL_INTERVAL ?? 2_000,
);

function configuredPublicUrl() {
  const configured = process.env.RESPONDER_NGROK_URL;
  if (!configured) {
    throw new Error("RESPONDER_NGROK_URL is required to start the ngrok relay.");
  }

  const url = new URL(configured);
  if (
    url.protocol !== "https:" ||
    url.origin + "/" !== url.href ||
    url.username ||
    url.password
  ) {
    throw new Error("RESPONDER_NGROK_URL must be an HTTPS origin without a path.");
  }
  return url.origin;
}

const publicUrl = configuredPublicUrl();
let relayMonitor;
let ngrokProcess;
let shuttingDown = false;

const server = createServer((request, response) => {
  if (request.url !== "/__responder_ngrok") {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "x-responder-ngrok": relayMarker,
    "x-responder-ngrok-url": publicUrl,
  });
  response.end("ok");
});

function existingRelayStatus() {
  return new Promise((resolve) => {
    const request = get(
      `http://${host}:${controlPort}/__responder_ngrok`,
      (response) => {
        const compatible =
          response.statusCode === 200 &&
          response.headers["x-responder-ngrok"] === relayMarker;
        const url = response.headers["x-responder-ngrok-url"];
        response.resume();
        resolve({ compatible, url: typeof url === "string" ? url : null });
      },
    );
    request.setTimeout(1_000, () => request.destroy());
    request.on("error", () => resolve({ compatible: false, url: null }));
  });
}

function startNgrok() {
  ngrokProcess = spawn(
    "ngrok",
    [
      "http",
      routerUrl,
      `--url=${publicUrl}`,
      "--inspect=true",
      "--log=stdout",
      "--log-format=logfmt",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  ngrokProcess.stdout.pipe(process.stdout);
  ngrokProcess.stderr.pipe(process.stderr);
  ngrokProcess.on("error", (error) => {
    process.stderr.write(`Unable to start ngrok: ${error.message}\n`);
  });
  ngrokProcess.on("exit", (code, signal) => {
    ngrokProcess = undefined;
    if (shuttingDown) return;
    process.stderr.write(
      `ngrok stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}).\n`,
    );
    server.close(() => process.exit(code ?? 1));
  });
}

function monitorExistingRelay() {
  relayMonitor = setInterval(() => {
    void existingRelayStatus().then(({ compatible }) => {
      if (compatible) return;
      clearInterval(relayMonitor);
      relayMonitor = undefined;
      server.listen(controlPort, host);
    });
  }, monitorInterval);
}

function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (relayMonitor) clearInterval(relayMonitor);
  if (ngrokProcess) ngrokProcess.kill("SIGTERM");
  if (server.listening) {
    server.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

server.on("error", (error) => {
  if (error.code !== "EADDRINUSE") throw error;

  void existingRelayStatus().then(({ compatible, url }) => {
    if (!compatible) {
      process.stderr.write(
        `Port ${controlPort} is occupied by an incompatible process.\n`,
      );
      process.exit(1);
    }
    if (url !== publicUrl) {
      process.stderr.write(
        `The shared ngrok relay is using ${url}; expected ${publicUrl}.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`Reusing the ngrok relay at ${publicUrl}\n`);
    monitorExistingRelay();
  });
});

server.listen(controlPort, host, () => {
  process.stdout.write(
    `Starting ngrok at ${publicUrl}; inspect requests at http://127.0.0.1:4040\n`,
  );
  startNgrok();
});
