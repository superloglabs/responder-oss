import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  callbackTargetFile,
  clearCallbackTarget,
  readCallbackTarget,
  validCallbackTarget,
  writeCallbackTarget,
} from "./local-callback-routing.mjs";

const temporaryDirectories = [];
const repositoryRoot = process.cwd();
const bridgeScript = join(repositoryRoot, "scripts/local-callback-bridge.mjs");
const targetScript = join(repositoryRoot, "scripts/local-callback-target.mjs");

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "responder-callbacks-"));
  temporaryDirectories.push(directory);
  return directory;
}

function temporaryGitRepository() {
  const directory = temporaryDirectory();
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  return directory;
}

function nestedGitRepository(parent, name) {
  const directory = join(parent, name);
  mkdirSync(directory);
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  return directory;
}

function inWorkingDirectory(directory, operation) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return operation();
  } finally {
    process.chdir(previous);
  }
}

function targetFile(workspace) {
  return inWorkingDirectory(workspace, () => callbackTargetFile());
}

function writeTarget(workspace, target) {
  return inWorkingDirectory(workspace, () => writeCallbackTarget(target));
}

function readTarget(workspace) {
  return inWorkingDirectory(workspace, () => readCallbackTarget());
}

function clearTarget(workspace) {
  return inWorkingDirectory(workspace, () => clearCallbackTarget());
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

function startBridge(port, workspace, stdio = "ignore") {
  return spawn(process.execPath, [bridgeScript], {
    cwd: workspace,
    env: {
      ...process.env,
      RESPONDER_CALLBACK_BRIDGE_POLL_INTERVAL: "25",
      RESPONDER_CALLBACK_BRIDGE_PORT: String(port),
    },
    stdio,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("local callback routing", () => {
  it("stores a shared loopback target atomically", () => {
    const workspace = temporaryGitRepository();
    const storedTargetFile = targetFile(workspace);

    writeTarget(
      workspace,
      {
        browserOrigin: "https://responder.test",
        origin: "http://127.0.0.1:4321",
        workspace: "/tmp/worktree",
        updatedAt: "2026-07-31T00:00:00.000Z",
      },
    );

    expect(storedTargetFile).toBe(
      join(
        realpathSync(workspace),
        ".git/responder/callback-target.json",
      ),
    );
    expect(readTarget(workspace)).toEqual({
      browserOrigin: "https://responder.test",
      origin: "http://127.0.0.1:4321",
      workspace: "/tmp/worktree",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(storedTargetFile, "utf8"))).toMatchObject({
      browserOrigin: "https://responder.test",
      origin: "http://127.0.0.1:4321",
    });
    expect(statSync(storedTargetFile).mode & 0o777).toBe(0o600);

    clearTarget(workspace);
    expect(readTarget(workspace)).toBeNull();
  });

  it("shares a callback target across nested repositories in one workspace root", () => {
    const sharedRoot = temporaryGitRepository();
    const firstWorkspace = nestedGitRepository(sharedRoot, "first");
    const secondWorkspace = nestedGitRepository(sharedRoot, "second");

    writeTarget(
      firstWorkspace,
      {
        origin: "http://127.0.0.1:4321",
        workspace: firstWorkspace,
        updatedAt: "2026-07-31T00:00:00.000Z",
      },
    );

    expect(targetFile(secondWorkspace)).toBe(
      join(realpathSync(sharedRoot), ".git/responder/callback-target.json"),
    );
    expect(readTarget(secondWorkspace)).toMatchObject({
      origin: "http://127.0.0.1:4321",
      workspace: firstWorkspace,
    });
  });

  it("rejects non-loopback and credentialed targets", () => {
    expect(
      validCallbackTarget({ origin: "https://example.com:443" }),
    ).toBeNull();
    expect(
      validCallbackTarget({ origin: "http://user:pass@localhost:4321" }),
    ).toBeNull();
    expect(
      validCallbackTarget({
        browserOrigin: "http://responder.example",
        origin: "http://localhost:4321",
      }),
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
    const workspace = temporaryGitRepository();
    const storedTargetFile = targetFile(workspace);
    const selection = spawn(
      process.execPath,
      [targetScript, "use"],
      {
        cwd: workspace,
        env: {
          ...process.env,
          BETTER_AUTH_URL: `http://127.0.0.1:${controlPlanePort}`,
          CONTROL_PLANE_WEB_PORT: String(controlPlanePort),
          PORTLESS_URL: "https://responder.test",
        },
        stdio: "ignore",
      },
    );

    try {
      const [exitCode] = await once(selection, "exit");
      expect(exitCode).toBe(0);
      expect(JSON.parse(readFileSync(storedTargetFile, "utf8"))).toMatchObject({
        browserOrigin: "https://responder.test",
        origin: `http://127.0.0.1:${controlPlanePort}`,
        workspace: realpathSync(workspace),
      });
    } finally {
      if (selection.exitCode === null) selection.kill("SIGTERM");
      await new Promise((resolve) => controlPlane.close(resolve));
    }
  });

  it("releases only the current worktree's claim", async () => {
    const workspace = temporaryGitRepository();
    const storedTargetFile = targetFile(workspace);
    writeTarget(
      workspace,
      {
        browserOrigin: "https://responder.test",
        origin: "http://127.0.0.1:4321",
        workspace: realpathSync(workspace),
        updatedAt: "2026-07-31T00:00:00.000Z",
      },
    );
    const release = spawn(
      process.execPath,
      [targetScript, "release"],
      {
        cwd: workspace,
        env: process.env,
        stdio: "ignore",
      },
    );

    const [exitCode] = await once(release, "exit");
    expect(exitCode).toBe(0);
    expect(() => readFileSync(storedTargetFile, "utf8")).toThrow();
  });

  it("keeps retrying a watched claim when local setup is incomplete", async () => {
    const workspace = temporaryGitRepository();
    const selection = spawn(
      process.execPath,
      [targetScript, "claim", "--wait", "--watch"],
      {
        cwd: workspace,
        env: { ...process.env, CONTROL_PLANE_WEB_PORT: "" },
        stdio: "ignore",
      },
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(selection.exitCode).toBeNull();
    } finally {
      selection.kill("SIGTERM");
      await once(selection, "exit");
    }
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

    const workspace = temporaryGitRepository();
    writeTarget(
      workspace,
      {
        origin: `http://127.0.0.1:${upstreamPort}`,
        workspace: "/tmp/worktree",
        updatedAt: "2026-07-31T00:00:00.000Z",
      },
    );

    const bridge = startBridge(bridgePort, workspace);

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

  it.each(["axiom", "slack"])(
    "redirects %s OAuth callbacks to the selected local origin",
    async (provider) => {
      const portReservation = createServer();
      const bridgePort = await listen(portReservation);
      await new Promise((resolve) => portReservation.close(resolve));
      const workspace = temporaryGitRepository();
      writeTarget(
        workspace,
        {
          browserOrigin: "https://responder.test",
          origin: "http://127.0.0.1:4321",
          workspace: "/tmp/worktree",
          updatedAt: "2026-07-31T00:00:00.000Z",
        },
      );
      const bridge = startBridge(bridgePort, workspace);

      try {
        await waitForBridge(bridgePort);
        const response = await fetch(
          `http://127.0.0.1:${bridgePort}/api/integrations/${provider}/callback` +
            "?code=oauth-code&state=oauth-state",
          { redirect: "manual" },
        );

        expect(response.status).toBe(302);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("location")).toBe(
          `https://responder.test/api/integrations/${provider}/callback` +
            "?code=oauth-code&state=oauth-state",
        );
      } finally {
        bridge.kill("SIGTERM");
        await Promise.race([
          once(bridge, "exit"),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
    },
  );

  it("routes a GitHub setup fallback through the claimed worktree", async () => {
    const upstream = createServer((request, response) => {
      response.end("ok");
    });
    const upstreamPort = await listen(upstream);
    const portReservation = createServer();
    const bridgePort = await listen(portReservation);
    await new Promise((resolve) => portReservation.close(resolve));
    const workspace = temporaryGitRepository();
    writeTarget(
      workspace,
      {
        origin: `http://127.0.0.1:${upstreamPort}`,
        workspace: "/tmp/worktree",
        updatedAt: "2026-07-31T00:00:00.000Z",
      },
    );
    const bridge = startBridge(bridgePort, workspace);

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
    const workspace = temporaryGitRepository();
    const bridge = startBridge(bridgePort, workspace, [
      "ignore",
      "pipe",
      "pipe",
    ]);

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
        "responder-local-callback-router-v3",
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
