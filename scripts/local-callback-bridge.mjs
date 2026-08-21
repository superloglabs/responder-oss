import { Buffer } from "node:buffer";
import { createServer, get, request as createRequest } from "node:http";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { URL } from "node:url";
import { readCallbackTarget } from "./local-callback-routing.mjs";

const host = "127.0.0.1";
const port = Number(process.env.RESPONDER_CALLBACK_BRIDGE_PORT ?? 4100);
const monitorInterval = Number(
  process.env.RESPONDER_CALLBACK_BRIDGE_POLL_INTERVAL ?? 2_000,
);
const callbackPath = "/github/install/callback";
const browserOAuthCallbackPaths = new Set([
  "/api/integrations/axiom/callback",
  "/api/integrations/clickstack/callback",
  "/api/integrations/custom_mcp/callback",
  "/api/integrations/github/callback",
  "/api/integrations/linear/callback",
  "/api/integrations/sentry/callback",
  "/api/integrations/slack/callback",
  "/api/integrations/vercel/callback",
]);
const bridgeMarker = "responder-local-callback-bridge-v1";
const routerMarker = "responder-local-callback-router-v3";
let relayMonitor;

function forwardedHeaders(headers, target) {
  const forwarded = { ...headers };
  forwarded.host = target.host;
  delete forwarded.connection;
  delete forwarded["proxy-connection"];
  delete forwarded["keep-alive"];
  delete forwarded.te;
  delete forwarded.trailer;
  delete forwarded["transfer-encoding"];
  delete forwarded.upgrade;
  return forwarded;
}

function proxyRequest(incoming, request, response) {
  const selectedTarget = readCallbackTarget();
  if (!selectedTarget) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    response.end("No worktree is selected. Run pnpm callbacks:use first.\n");
    return;
  }

  const target = new URL(incoming.pathname + incoming.search, selectedTarget.origin);
  const upstream = createRequest(
    target,
    {
      method: request.method,
      headers: forwardedHeaders(request.headers, target),
    },
    (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers };
      delete headers.connection;
      delete headers["keep-alive"];
      delete headers["transfer-encoding"];
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("The selected worktree is unavailable.\n");
  });
  request.pipe(upstream);
}

function routedCallbackUrl(state) {
  const [version, encodedUrl] = state?.split(".", 3) ?? [];
  if (version !== "responder-v1" || !encodedUrl) return null;

  try {
    const url = new URL(Buffer.from(encodedUrl, "base64url").toString("utf8"));
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (
      url.protocol !== "http:" ||
      !loopbackHosts.has(url.hostname) ||
      url.pathname !== "/api/integrations/github/callback" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function fallbackCallbackUrl() {
  const selectedTarget = readCallbackTarget();
  return selectedTarget
    ? new URL("/api/integrations/github/callback", selectedTarget.origin)
    : null;
}

function browserOAuthCallbackUrl(incoming, method) {
  if (method !== "GET" || !browserOAuthCallbackPaths.has(incoming.pathname)) {
    return null;
  }
  const selectedTarget = readCallbackTarget();
  if (!selectedTarget) return null;
  return new URL(
    incoming.pathname + incoming.search,
    selectedTarget.browserOrigin ?? selectedTarget.origin,
  );
}

const server = createServer((request, response) => {
  const incoming = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (incoming.pathname === "/__responder_callback_bridge") {
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "x-responder-callback-bridge": bridgeMarker,
      "x-responder-callback-router": routerMarker,
    });
    response.end("ok");
    return;
  }
  const localBrowserCallback = browserOAuthCallbackUrl(
    incoming,
    request.method,
  );
  if (localBrowserCallback) {
    response.writeHead(302, {
      "cache-control": "no-store",
      location: localBrowserCallback.toString(),
    });
    response.end();
    return;
  }
  if (incoming.pathname !== callbackPath) {
    proxyRequest(incoming, request, response);
    return;
  }

  const target =
    routedCallbackUrl(incoming.searchParams.get("state")) ??
    fallbackCallbackUrl();
  if (!target) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    response.end("No worktree is selected. Run pnpm tunnel:claim first.\n");
    return;
  }
  target.search = incoming.search;
  response.writeHead(302, {
    "cache-control": "no-store",
    location: target.toString(),
  });
  response.end();
});

function existingBridgeStatus() {
  return new Promise((resolve) => {
    const request = get(
      `http://${host}:${port}/__responder_callback_bridge`,
      (response) => {
        const compatible =
          response.statusCode === 200 &&
          response.headers["x-responder-callback-bridge"] === bridgeMarker;
        const routing =
          compatible &&
          response.headers["x-responder-callback-router"] === routerMarker;
        response.resume();
        resolve({ compatible, routing });
      },
    );
    request.setTimeout(1_000, () => request.destroy());
    request.on("error", () => resolve({ compatible: false, routing: false }));
  });
}

function monitorExistingBridge() {
  relayMonitor = setInterval(() => {
    void existingBridgeStatus().then(({ compatible }) => {
      if (compatible) return;
      clearInterval(relayMonitor);
      relayMonitor = undefined;
      server.listen(port, host);
    });
  }, monitorInterval);
}

server.on("error", (error) => {
  if (error.code !== "EADDRINUSE") throw error;

  void existingBridgeStatus().then(({ compatible, routing }) => {
    if (!compatible) {
      process.stderr.write(
        `Port ${port} is occupied by an incompatible process. Stop it and restart local development.\n`,
      );
      process.exit(1);
    }

    if (routing) {
      process.stdout.write(
        `Reusing the callback bridge already running on http://localhost:${port}\n`,
      );
    } else {
      process.stdout.write(
        `Waiting for the legacy callback bridge on port ${port} to stop before enabling worktree routing.\n`,
      );
    }
    monitorExistingBridge();
  });
});

server.listen(port, host, () => {
  process.stdout.write(
    `Callback bridge listening on http://localhost:${port}\n`,
  );
});
