import {
  clearSandboxImage,
  completeSandboxImageBuild,
  failSandboxImageBuild,
  finishSandboxImageSnapshotDeletion,
  getSandboxImage,
  getSandboxImageRebuildRequestedAt,
  getSandboxImageSettings,
  listDueSandboxImageSnapshotDeletions,
  listSandboxImageWorkspaces,
  queueSandboxImageSnapshotDeletion,
  recordSandboxImageBuildLog,
  retrySandboxImageSnapshotDeletion,
  startSandboxImageBuild,
  type SandboxImageWorkspace,
} from "@responder/core/db/sandbox-image";
import {
  requireSandboxConfig,
  sandboxHome,
  sandboxWorkspaceRoot,
  type SandboxConfig,
  type VercelSandboxConfig,
} from "@responder/core/sandbox-config";
import {
  sandboxImageKey,
  sandboxImageRequired,
  sandboxImageSnapshotFor,
  sandboxMemoryGiBPerVcpu,
  type SandboxImageBase,
  type SandboxImageRecord,
} from "@responder/core/sandbox-image";
import { Sandbox, Snapshot } from "@vercel/sandbox";
import type { SandboxSession } from "./sandbox-session.js";
import { sandboxSnapshotResources } from "./sandbox-snapshot.js";

// The sandbox a workspace's run starts with: its snapshot when one has built,
// its size, and the command to run once the sandbox is up. Workspace sandbox
// settings apply on Vercel only, so Daytona sandboxes have no size here and
// are metered as before.
export interface WorkspaceSandbox<Config extends SandboxConfig = SandboxConfig> {
  config: Config;
  resources?: { cpu: number; disk: number; memory: number };
  startCommand: string;
}

interface WorkspaceSandboxDependencies {
  getImage: typeof getSandboxImage;
  getSettings: typeof getSandboxImageSettings;
}

const defaultWorkspaceDependencies: WorkspaceSandboxDependencies = {
  getImage: getSandboxImage,
  getSettings: getSandboxImageSettings,
};

export function sandboxImageBase(config: VercelSandboxConfig): SandboxImageBase {
  return { region: config.region, snapshotId: config.sandboxSnapshotName };
}

export async function workspaceSandbox<Config extends SandboxConfig>(
  organizationId: string,
  config: Config,
  dependencies: WorkspaceSandboxDependencies = defaultWorkspaceDependencies,
): Promise<WorkspaceSandbox<Config>> {
  if (!config.vercel) {
    return { config, startCommand: "" };
  }
  const settings = await dependencies.getSettings(organizationId);
  const image = sandboxImageRequired(settings)
    ? await dependencies.getImage(organizationId)
    : null;
  const snapshotId = sandboxImageSnapshotFor(settings, image, sandboxImageBase(config));
  if (sandboxImageRequired(settings) && !snapshotId) {
    // The run starts without the workspace's packages until its snapshot builds.
    console.error(JSON.stringify({
      event: "sandbox_image_unavailable",
      imageStatus: image?.status ?? null,
      organizationId,
    }));
  }
  return {
    config: {
      ...config,
      sandboxSnapshotName: snapshotId ?? config.sandboxSnapshotName,
      vcpus: settings.vcpus,
    },
    resources: {
      ...sandboxSnapshotResources,
      cpu: settings.vcpus,
      memory: settings.vcpus * sandboxMemoryGiBPerVcpu,
    },
    startCommand: settings.startCommand,
  };
}

const startCommandLogPath = "/tmp/responder-start-command.log";
const startCommandTimeoutSeconds = 300;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Runs the workspace's start command in a sandbox that just started or
// resumed, stopping at the first failing command. Its output goes to a file,
// so a process it leaves running in the background, such as a daemon, does
// not hold the command open.
export async function runSandboxStartCommand(
  session: SandboxSession,
  startCommand: string,
): Promise<void> {
  if (!startCommand) return;
  const output = await session.execCommand({
    cmd: [
      "status=0",
      `timeout ${startCommandTimeoutSeconds} bash -eo pipefail -c ${shellQuote(startCommand)} >${startCommandLogPath} 2>&1 </dev/null || status=$?`,
      `tail -c 4000 ${startCommandLogPath}`,
      'exit "$status"',
    ].join("\n"),
    maxOutputTokens: 1_500,
    workdir: sandboxWorkspaceRoot,
  });
  if (!/(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output)) {
    const detail = output.split("\nOutput:\n", 2)[1]?.trim();
    throw new Error(
      `The workspace sandbox start command failed${detail ? `: ${detail}` : ""}`,
    );
  }
}

const buildTimeoutMs = 45 * 60 * 1_000;
const buildLogLimit = 32_000;
const setupScriptPath = "/tmp/responder-setup.sh";

export type SandboxImageBuildOutcome =
  | "built"
  | "cleared"
  | "current"
  | "failed"
  | "unsupported";

interface BuildDependencies {
  clear: typeof clearSandboxImage;
  complete: typeof completeSandboxImageBuild;
  createSandbox: typeof Sandbox.create;
  fail: typeof failSandboxImageBuild;
  getImage: typeof getSandboxImage;
  getRebuildRequestedAt: typeof getSandboxImageRebuildRequestedAt;
  getSettings: typeof getSandboxImageSettings;
  queueDeletion: typeof queueSandboxImageSnapshotDeletion;
  recordLog: typeof recordSandboxImageBuildLog;
  start: typeof startSandboxImageBuild;
}

const defaultBuildDependencies: BuildDependencies = {
  clear: clearSandboxImage,
  complete: completeSandboxImageBuild,
  createSandbox: (...args) => Sandbox.create(...args),
  fail: failSandboxImageBuild,
  getImage: getSandboxImage,
  getRebuildRequestedAt: getSandboxImageRebuildRequestedAt,
  getSettings: getSandboxImageSettings,
  queueDeletion: queueSandboxImageSnapshotDeletion,
  recordLog: recordSandboxImageBuildLog,
  start: startSandboxImageBuild,
};

// A failed step of the workspace's own build, as opposed to a Vercel error.
class SandboxImageStepError extends Error {}

// An admin asked for a rebuild after the image last built.
function rebuildRequested(
  rebuildRequestedAt: Date | null,
  image: SandboxImageRecord | null,
): boolean {
  return rebuildRequestedAt !== null &&
    (!image || rebuildRequestedAt.getTime() > image.startedAt.getTime());
}

// Builds the workspace's snapshot from its current settings on the cell's base
// snapshot: its packages, then its setup script, as the sandbox user with sudo.
// A build stopped by `signal` stops its sandbox and leaves the image building,
// so the next maintenance pass queues it again.
export async function buildSandboxImage(
  organizationId: string,
  options: { signal?: AbortSignal } = {},
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: BuildDependencies = defaultBuildDependencies,
): Promise<SandboxImageBuildOutcome> {
  const config = requireSandboxConfig(environment);
  if (!config.vercel) return "unsupported";
  const settings = await dependencies.getSettings(organizationId);
  if (!sandboxImageRequired(settings)) {
    await dependencies.clear(organizationId);
    return "cleared";
  }
  const base = sandboxImageBase(config);
  const key = sandboxImageKey(settings, base);
  const [image, rebuildRequestedAt] = await Promise.all([
    dependencies.getImage(organizationId),
    dependencies.getRebuildRequestedAt(organizationId),
  ]);
  if (
    !rebuildRequested(rebuildRequestedAt, image) &&
    image?.snapshotKey === key &&
    image.snapshotId
  ) {
    // Nothing changed, or the settings went back to ones that already built.
    // Recording it again shows the request as handled.
    await dependencies.start(organizationId, key);
    await dependencies.complete(
      organizationId,
      key,
      { ...base, builtSnapshotId: image.snapshotId },
      image.log,
    );
    return "current";
  }
  options.signal?.throwIfAborted();

  await dependencies.start(organizationId, key);
  let log = "";
  const append = async (text: string) => {
    log = `${log}${text}`.slice(-buildLogLimit);
    await dependencies.recordLog(organizationId, key, log);
  };
  const sandbox = await dependencies.createSandbox({
    ...config.vercel,
    persistent: false,
    region: config.region,
    resources: { vcpus: settings.vcpus },
    source: { snapshotId: base.snapshotId, type: "snapshot" },
    timeout: buildTimeoutMs,
  }).catch(async (error: unknown) => {
    await dependencies.fail(organizationId, key, "Could not start a sandbox to build in", log);
    throw error;
  });
  // Stopping the sandbox ends the command it is running.
  const stop = () => void sandbox.stop().catch(() => undefined);
  options.signal?.addEventListener("abort", stop, { once: true });
  let builtSnapshotId: string | undefined;
  try {
    const run = async (label: string, command: string) => {
      options.signal?.throwIfAborted();
      await append(`$ ${label}\n`);
      const result = await sandbox.runCommand({
        args: ["-lc", command],
        cmd: "/bin/bash",
        cwd: sandboxHome,
      });
      await append(`${await result.output("both")}\n`);
      options.signal?.throwIfAborted();
      if (result.exitCode !== 0) {
        throw new SandboxImageStepError(`${label} exited with code ${result.exitCode}`);
      }
    };
    if (settings.packages.length > 0) {
      // Package names are validated, so they need no quoting.
      const packages = settings.packages.join(" ");
      await run(`sudo dnf install -y ${packages}`, `sudo dnf install -y -q ${packages}`);
    }
    if (settings.setupScript) {
      await sandbox.writeFiles([
        { content: Buffer.from(`${settings.setupScript}\n`), path: setupScriptPath },
      ]);
      await run("setup script", `set -eo pipefail; bash -eo pipefail ${setupScriptPath}`);
    }
    await run(
      "clean up",
      `rm -f ${setupScriptPath}; sudo dnf clean all -q >/dev/null 2>&1 || true`,
    );
    // Taking the snapshot also stops the sandbox.
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    builtSnapshotId = snapshot.snapshotId;
    log = `${log}Built snapshot ${snapshot.snapshotId}.\n`.slice(-buildLogLimit);
    await dependencies.complete(
      organizationId,
      key,
      { ...base, builtSnapshotId: snapshot.snapshotId },
      log,
    );
    return "built";
  } catch (error) {
    if (!builtSnapshotId) stop();
    if (builtSnapshotId) {
      // The snapshot was not recorded, so nothing else would delete it.
      await dependencies.queueDeletion(builtSnapshotId).catch(() => undefined);
    }
    if (options.signal?.aborted) throw error;
    const message = error instanceof SandboxImageStepError
      ? error.message
      : "The build stopped on a sandbox error";
    await dependencies.fail(organizationId, key, message, log);
    if (error instanceof SandboxImageStepError) return "failed";
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", stop);
  }
}

// Whether a workspace's image needs a build job: its settings or the base
// snapshot changed, an admin asked for a rebuild, a build was cut off, or
// settings that no longer need an image left one behind. A job for a build
// already running waits behind it and finds nothing to do.
export function sandboxImageNeedsBuild(
  workspace: SandboxImageWorkspace,
  base: SandboxImageBase,
): boolean {
  const { image, settings } = workspace;
  if (!sandboxImageRequired(settings)) return image !== null;
  return image?.key !== sandboxImageKey(settings, base) ||
    image.status === "building" ||
    rebuildRequested(workspace.rebuildRequestedAt, image);
}

interface MaintenanceDependencies {
  deleteSnapshot(config: VercelSandboxConfig, snapshotId: string): Promise<void>;
  finishDeletion: typeof finishSandboxImageSnapshotDeletion;
  listDeletions: typeof listDueSandboxImageSnapshotDeletions;
  listWorkspaces: typeof listSandboxImageWorkspaces;
  retryDeletion: typeof retrySandboxImageSnapshotDeletion;
}

function isNotFound(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "response" in error
    ? (error.response as { status?: unknown } | undefined)?.status
    : undefined;
  return status === 404;
}

const defaultMaintenanceDependencies: MaintenanceDependencies = {
  deleteSnapshot: async (config, snapshotId) => {
    try {
      const snapshot = await Snapshot.get({ ...config.vercel, snapshotId });
      await snapshot.delete();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  },
  finishDeletion: finishSandboxImageSnapshotDeletion,
  listDeletions: listDueSandboxImageSnapshotDeletions,
  listWorkspaces: listSandboxImageWorkspaces,
  retryDeletion: retrySandboxImageSnapshotDeletion,
};

const maxDeletionRetryDelayMs = 6 * 60 * 60 * 1_000;

// Run at boot and on an interval. Queues a build for every workspace whose
// image needs one, so a lost queue request or a new base snapshot is caught
// up, then deletes the snapshots that are due. Returns what it did.
export async function maintainSandboxImages(
  queue: (organizationId: string) => Promise<void>,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: MaintenanceDependencies = defaultMaintenanceDependencies,
  now: Date = new Date(),
): Promise<{ deleted: number; queued: number }> {
  const config = requireSandboxConfig(environment);
  if (!config.vercel) return { deleted: 0, queued: 0 };
  const base = sandboxImageBase(config);
  let queued = 0;
  for (const workspace of await dependencies.listWorkspaces()) {
    if (!sandboxImageNeedsBuild(workspace, base)) continue;
    await queue(workspace.organizationId);
    queued += 1;
  }
  let deleted = 0;
  for (const deletion of await dependencies.listDeletions(now)) {
    try {
      await dependencies.deleteSnapshot(config, deletion.snapshotId);
      await dependencies.finishDeletion(deletion.snapshotId);
      deleted += 1;
    } catch (error) {
      const delayMs = Math.min(2 ** deletion.attempts * 5 * 60 * 1_000, maxDeletionRetryDelayMs);
      await dependencies.retryDeletion(
        deletion.snapshotId,
        error instanceof Error ? error.message : String(error),
        new Date(now.getTime() + delayMs),
      );
    }
  }
  return { deleted, queued };
}
