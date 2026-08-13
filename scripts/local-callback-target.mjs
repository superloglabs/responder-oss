import { readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import {
  clearCallbackTarget,
  readCallbackTarget,
  writeCallbackTarget,
} from "./local-callback-routing.mjs";

const command = process.argv[2] ?? "status";
const waitForHealth = process.argv.includes("--wait");
const keepWatching = process.argv.includes("--watch");
const healthPollInterval = Number(
  process.env.RESPONDER_CALLBACK_TARGET_POLL_INTERVAL ?? 500,
);
const healthTimeout = Number(
  process.env.RESPONDER_CALLBACK_TARGET_TIMEOUT ?? 60_000,
);

function localWebPort() {
  if (process.env.CONTROL_PLANE_WEB_PORT) {
    return process.env.CONTROL_PLANE_WEB_PORT;
  }

  const environment = readFileSync(".env.local", "utf8");
  const match = environment.match(/^CONTROL_PLANE_WEB_PORT=(\d+)$/m);
  if (!match) {
    throw new Error(
      "CONTROL_PLANE_WEB_PORT is missing. Run pnpm local:setup first.",
    );
  }
  return match[1];
}

function currentWorkspace() {
  return realpathSync(process.cwd());
}

function printPublicEndpoints() {
  const publicUrl = process.env.RESPONDER_PUBLIC_URL?.replace(/\/$/, "");
  if (!publicUrl) return;
  process.stdout.write(`Public origin: ${publicUrl}\n`);
  process.stdout.write(`  Slack OAuth:     ${publicUrl}/api/integrations/slack/callback\n`);
  process.stdout.write(`  Slack events:    ${publicUrl}/api/webhooks/slack\n`);
  process.stdout.write(`  Slack actions:   ${publicUrl}/api/webhooks/slack/actions\n`);
  process.stdout.write(`  GitHub callback: ${publicUrl}/api/integrations/github/callback\n`);
  process.stdout.write(`  GitHub setup:    ${publicUrl}/github/install/callback\n`);
  process.stdout.write(`  Sentry callback: ${publicUrl}/api/integrations/sentry/callback\n`);
  process.stdout.write(`  Sentry webhook:  ${publicUrl}/api/webhooks/sentry\n`);
  process.stdout.write(`  ClickStack OAuth: ${publicUrl}/api/integrations/clickstack/callback\n`);
}

async function targetIsHealthy(origin) {
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntilHealthy(origin) {
  const deadline = Date.now() + healthTimeout;
  while (Date.now() < deadline) {
    if (await targetIsHealthy(origin)) return true;
    await new Promise((resolve) => setTimeout(resolve, healthPollInterval));
  }
  return false;
}

function watchCurrentWorkspace(workspace) {
  const timer = setInterval(() => {}, 60_000);
  const stop = () => {
    clearInterval(timer);
    const target = readCallbackTarget();
    if (target?.workspace === workspace) clearCallbackTarget();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function useCurrentWorkspace() {
  const port = localWebPort();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error(`Invalid CONTROL_PLANE_WEB_PORT: ${port}`);
  }

  const origin = `http://127.0.0.1:${port}`;
  const healthy = waitForHealth
    ? await waitUntilHealthy(origin)
    : await targetIsHealthy(origin);
  if (!healthy) {
    throw new Error(
      `The control plane is not healthy at ${origin}. Start this worktree before selecting it.`,
    );
  }

  const previous = readCallbackTarget();
  const target = writeCallbackTarget({
    origin,
    workspace: currentWorkspace(),
    updatedAt: new Date().toISOString(),
  });
  if (previous && previous.workspace !== target.workspace) {
    process.stdout.write(`Released ${previous.workspace} (${previous.origin}).\n`);
  }
  process.stdout.write(
    `Tunnel claimed by ${target.workspace} (${target.origin}).\n`,
  );
  printPublicEndpoints();
  if (keepWatching) watchCurrentWorkspace(target.workspace);
}

function releaseCurrentWorkspace() {
  const target = readCallbackTarget();
  if (!target) {
    process.stdout.write("The tunnel is not claimed.\n");
    return;
  }

  const workspace = currentWorkspace();
  if (target.workspace !== workspace) {
    process.stdout.write(
      `Tunnel claim belongs to ${target.workspace}; leaving it unchanged.\n`,
    );
    return;
  }

  clearCallbackTarget();
  process.stdout.write(`Tunnel released by ${workspace}.\n`);
}

async function printStatus() {
  const target = readCallbackTarget();
  if (!target) {
    process.stdout.write("The tunnel is not claimed.\n");
    printPublicEndpoints();
    return;
  }

  const health = (await targetIsHealthy(target.origin)) ? "healthy" : "offline";
  process.stdout.write(
    `Tunnel is claimed by ${target.workspace} (${target.origin}, ${health}).\n`,
  );
  printPublicEndpoints();
}

try {
  if (command === "use" || command === "claim") {
    await useCurrentWorkspace();
  } else if (command === "status") {
    await printStatus();
  } else if (command === "release") {
    releaseCurrentWorkspace();
  } else if (command === "clear") {
    clearCallbackTarget();
    process.stdout.write("Tunnel claim forcibly cleared.\n");
  } else {
    throw new Error(
      "Usage: local-callback-target.mjs claim [--wait] [--watch]|status|release|clear",
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
