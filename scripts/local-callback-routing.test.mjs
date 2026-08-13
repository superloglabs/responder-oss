import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCallbackTarget,
  readCallbackTarget,
  validCallbackTarget,
  writeCallbackTarget,
} from "./local-callback-routing.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "responder-callbacks-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function listen(server, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
  return server.address().port;
}

async function waitForBridge(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/__responder_callback_bridge`,
      );
      if (response.ok) return;
    } catch {
      // The bridge may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Callback bridge did not start.");
}

function startBridge(port, targetFile, stdio = "ignore") {
  return spawn(process.execPath, ["scripts/local-callback-bridge.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RESPONDER_CALLBACK_BRIDGE_POLL_INTERVAL: "25",
      RESPONDER_CALLBACK_BRIDGE_PORT: String(port),
      RESPONDER_CALLBACK_TARGET_FILE: targetFile,
    },
    stdio,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("local callback routing", () => {
  it("stores a shared loopback target atomically", () => {
    const targetFile = join(temporaryDirectory(), "target.json");
    vi.stubEnv("RESPONDER_CALLBACK_TARGET_FILE", targetFile);

    writeCallbackTarget({
      origin: "http://127.0.0.1:4321",
      workspace: "/tmp/worktree",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    expect(readCallbackTarget()).toEqual({
      origin: "http://127.0.0.1:4321",
      workspace: "/tmp/worktree",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(targetFile, "utf8"))).toMatchObject({
      origin: "http://127.0.0.1:4321",
    });

    clearCallbackTarget();
    expect(readCallbackTarget()).toBeNull();
  });

  it("rejects non-loopback and credentialed targets", () => {
    expect(
      validCallbackTarget({ origin: "https://example.com:443" }),
    ).toBeNull();
    expect(
      validCallbackTarget({ origin: "http://user:pass@localhost:4321" }),
    ).toBeNull();
  });

  it("selects the current worktree only after its health check passes", async () => {
    const controlPlane = createServer((request, response) => {
      if (request.url === "/api/health") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      response.writeHead(404).end();
    });
    const controlPlanePort = await listen(controlPlane);
    const targetFile = join(temporaryDirectory(), "target.json");
    const selection = spawn(
      process.execPath,
      ["scripts/local-callback-target.mjs", "use"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CONTROL_PLANE_WEB_PORT: String(controlPlanePort),
          RESPONDER_CALLBACK_TARGET_FILE: targetFile,
        },
        stdio: "ignore",
      },
    );

    try {
      const [exitCode] = await once(selection, "exit");
      expect(exitCode).toBe(0);
      expect(JSON.parse(readFileSync(targetFile, "utf8"))).toMatchObject({
        origin: `http://127.0.0.1:${controlPlanePort}`,
        workspace: realpathSync(process.cwd()),
      });
    } finally {
      if (selection.exitCode === null) selection.kill("SIGTERM");
      await new Promise((resolve) => controlPlane.close(resolve));
    }
  });

  it("releases only the current worktree's claim", async () => {
    const targetFile = join(temporaryDirectory(), "target.json");
    writeFileSync(
      targetFile,
      JSON.stringify({
        origin: "http://127.0.0.1:4321",
        workspace: realpathSync(process.cwd()),
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    );
    const release = spawn(
      process.execPath,
      ["scripts/local-callback-target.mjs", "release"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RESPONDER_CALLBACK_TARGET_FILE: targetFile,
        },
        stdio: "ignore",
      },
    );

    const [exitCode] = await once(release, "exit");
    expect(exitCode).toBe(0);
    expect(() => readFileSync(targetFile, "utf8")).toThrow();
  });

  it("proxies methods, paths, bodies, and query strings to the selection", async () => {
    const upstream = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            body,
            host: request.headers.host,
            method: request.method,
            url: request.url,
          }),
        );
      });
    });
    const upstreamPort = await listen(upstream);

    const portReservation = createServer();
    const bridgePort = await listen(portReservation);
    await new Promise((resolve) => portReservation.close(resolve));

    const targetFile = join(temporaryDirectory(), "target.json");
    writeFileSync(
      targetFile,
      JSON.stringify({
        origin: `http://127.0.0.1:${upstreamPort}`,
        workspace: "/tmp/worktree",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    );

    const bridge = startBridge(bridgePort, targetFile);

    try {
      await waitForBridge(bridgePort);
      const response = await fetch(
        `http://127.0.0.1:${bridgePort}/api/webhooks/slack?attempt=1`,
        {
          method: "POST",
          body: "payload",
          headers: { "content-type": "text/plain" },
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        body: "payload",
        host: `127.0.0.1:${upstreamPort}`,
        method: "POST",
        url: "/api/webhooks/slack?attempt=1",
      });
    } finally {
      bridge.kill("SIGTERM");
      await Promise.race([
        once(bridge, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      await new Promise((resolve) => upstream.close(resolve));
    }
  });

  it("routes a GitHub setup fallback through the claimed worktree", async () => {
    const upstream = createServer((request, response) => {
      response.end(request.url);
    });
    const upstreamPort = await listen(upstream);
    const portReservation = createServer();
    const bridgePort = await listen(portReservation);
    await new Promise((resolve) => portReservation.close(resolve));
    const targetFile = join(temporaryDirectory(), "target.json");
    writeFileSync(
      targetFile,
      JSON.stringify({
        origin: `http://127.0.0.1:${upstreamPort}`,
        workspace: "/tmp/worktree",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    );
    const bridge = startBridge(bridgePort, targetFile);

    try {
      await waitForBridge(bridgePort);
      const response = await fetch(
        `http://127.0.0.1:${bridgePort}/github/install/callback?state=invalid`,
        { redirect: "manual" },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `http://127.0.0.1:${upstreamPort}/api/integrations/github/callback?state=invalid`,
      );
    } finally {
      bridge.kill("SIGTERM");
      await Promise.race([
        once(bridge, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      await new Promise((resolve) => upstream.close(resolve));
    }
  });

  it("waits for a legacy bridge and takes over after it stops", async () => {
    const legacyBridge = createServer((request, response) => {
      if (request.url === "/__responder_callback_bridge") {
        response.setHeader(
          "x-responder-callback-bridge",
          "responder-local-callback-bridge-v1",
        );
        response.end("ok");
        return;
      }
      response.writeHead(404).end();
    });
    const bridgePort = await listen(legacyBridge);
    const targetFile = join(temporaryDirectory(), "target.json");
    const bridge = startBridge(bridgePort, targetFile, ["ignore", "pipe", "pipe"]);

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Bridge did not recognize its predecessor.")),
          1_000,
        );
        bridge.stdout.on("data", (chunk) => {
          if (!chunk.toString().includes("legacy callback bridge")) return;
          clearTimeout(timeout);
          resolve();
        });
      });
      expect(bridge.exitCode).toBeNull();

      await new Promise((resolve) => legacyBridge.close(resolve));
      await waitForBridge(bridgePort);
      const health = await fetch(
        `http://127.0.0.1:${bridgePort}/__responder_callback_bridge`,
      );
      expect(health.headers.get("x-responder-callback-router")).toBe(
        "responder-local-callback-router-v2",
      );
    } finally {
      bridge.kill("SIGTERM");
      await Promise.race([
        once(bridge, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      await new Promise((resolve) => legacyBridge.close(resolve));
    }
  });
});
