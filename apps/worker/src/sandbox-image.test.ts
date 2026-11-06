import { describe, expect, it, vi } from "vitest";
import {
  defaultSandboxImageSettings,
  sandboxImageKey,
  type SandboxImageRecord,
  type SandboxImageSettings,
} from "@responder/core/sandbox-image";
import type { VercelSandboxConfig } from "@responder/core/sandbox-config";
import {
  buildSandboxImage,
  maintainSandboxImages,
  runSandboxStartCommand,
  workspaceSandbox,
} from "./sandbox-image.js";
import type { SandboxSession } from "./sandbox-session.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const environment = {
  SANDBOX_PROVIDER: "vercel",
  VERCEL_PROJECT_ID: "prj_1",
  VERCEL_SANDBOX_REGION: "cdg1",
  VERCEL_SANDBOX_SNAPSHOT_ID: "snap_base",
  VERCEL_TEAM_ID: "team_1",
  VERCEL_TOKEN: "token",
};
const base = { region: "cdg1", snapshotId: "snap_base" };
const vercelConfig: VercelSandboxConfig = {
  region: "cdg1",
  sandboxSnapshotName: "snap_base",
  vercel: { projectId: "prj_1", teamId: "team_1", token: "token" },
};
const settings: SandboxImageSettings = {
  packages: ["ffmpeg", "valkey"],
  setupScript: "npx -y playwright install chromium",
  startCommand: "sudo dockerd >/tmp/dockerd.log 2>&1 &",
  vcpus: 4,
};

function image(overrides: Partial<SandboxImageRecord> = {}): SandboxImageRecord {
  const key = sandboxImageKey(settings, base);
  return {
    error: null,
    finishedAt: new Date("2026-11-03T12:00:00Z"),
    key,
    log: "",
    snapshotBaseId: base.snapshotId,
    snapshotBuiltAt: new Date("2026-11-03T12:00:00Z"),
    snapshotId: "snap_workspace",
    snapshotKey: key,
    snapshotRegion: base.region,
    snapshotStartCommand: settings.startCommand,
    startedAt: new Date("2026-11-03T11:55:00Z"),
    status: "ready",
    ...overrides,
  };
}

describe("workspace sandbox", () => {
  it("starts from the workspace snapshot at the chosen size", async () => {
    const sandbox = await workspaceSandbox(organizationId, vercelConfig, {
      getImage: vi.fn(async () => image()),
      getSettings: vi.fn(async () => settings),
    });
    expect(sandbox.config).toMatchObject({ sandboxSnapshotName: "snap_workspace", vcpus: 4 });
    expect(sandbox.resources).toMatchObject({ cpu: 4, memory: 8 });
    expect(sandbox.startCommand).toBe(settings.startCommand);
  });

  it("starts from the base snapshot until the workspace's first build finishes", async () => {
    const sandbox = await workspaceSandbox(organizationId, vercelConfig, {
      getImage: vi.fn(async () => null),
      getSettings: vi.fn(async () => settings),
    });
    expect(sandbox.config.sandboxSnapshotName).toBe("snap_base");
    expect(sandbox.startCommand).toBe("");
  });

  it("keeps the previous snapshot's start command until the new one is recorded", async () => {
    const sandbox = await workspaceSandbox(organizationId, vercelConfig, {
      getImage: vi.fn(async () => image({ snapshotStartCommand: "echo previous" })),
      getSettings: vi.fn(async () => settings),
    });
    expect(sandbox.config.sandboxSnapshotName).toBe("snap_workspace");
    expect(sandbox.startCommand).toBe("echo previous");
  });

  it("runs the start command when the workspace needs no snapshot", async () => {
    const startOnly = { ...defaultSandboxImageSettings, startCommand: "echo up" };
    const sandbox = await workspaceSandbox(organizationId, vercelConfig, {
      getImage: vi.fn(async () => null),
      getSettings: vi.fn(async () => startOnly),
    });
    expect(sandbox.startCommand).toBe("echo up");
  });

  it("leaves Daytona sandboxes unchanged", async () => {
    const getSettings = vi.fn(async () => settings);
    const config = { daytonaApiKey: "key", sandboxSnapshotName: "responder-sandbox" };
    const sandbox = await workspaceSandbox(organizationId, config, {
      getImage: vi.fn(async () => null),
      getSettings,
    });
    expect(sandbox.config).toBe(config);
    expect(sandbox.resources).toBeUndefined();
    expect(sandbox.startCommand).toBe("");
    expect(getSettings).not.toHaveBeenCalled();
  });
});

function fakeSandbox(failingCommand?: string) {
  const commands: string[] = [];
  const sandbox = {
    runCommand: vi.fn(async ({ args }: { args: string[] }) => {
      const command = args[1]!;
      commands.push(command);
      const finished = {
        exitCode: failingCommand && command.includes(failingCommand) ? 1 : 0,
        output: async () => `ran ${command}\n`,
      };
      return { wait: async () => finished };
    }),
    snapshot: vi.fn(async () => ({ snapshotId: "snap_new" })),
    stop: vi.fn(async () => undefined),
    writeFiles: vi.fn(async () => undefined),
  };
  return { commands, sandbox };
}

function buildDependencies(input: {
  image?: SandboxImageRecord | null;
  rebuildRequestedAt?: Date | null;
  sandbox?: ReturnType<typeof fakeSandbox>["sandbox"];
  settings?: SandboxImageSettings;
}) {
  return {
    clear: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    createSandbox: vi.fn(async () => input.sandbox as never),
    fail: vi.fn(async () => undefined),
    getImage: vi.fn(async () => input.image ?? null),
    getRebuildRequestedAt: vi.fn(async () => input.rebuildRequestedAt ?? null),
    getSettings: vi.fn(async () => input.settings ?? settings),
    queueDeletion: vi.fn(async () => undefined),
    recordLog: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
  };
}

describe("sandbox image build", () => {
  it("installs the packages, runs the script, and records the snapshot", async () => {
    const { commands, sandbox } = fakeSandbox();
    const dependencies = buildDependencies({ sandbox });
    await expect(buildSandboxImage(organizationId, {}, environment, dependencies))
      .resolves.toBe("built");
    const key = sandboxImageKey(settings, base);
    expect(dependencies.start).toHaveBeenCalledWith(organizationId, key);
    expect(dependencies.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
      region: "cdg1",
      resources: { vcpus: 4 },
      source: { snapshotId: "snap_base", type: "snapshot" },
    }));
    expect(commands[0]).toBe("sudo dnf install -y -q ffmpeg valkey");
    expect(commands[1]).toContain("bash -eo pipefail /tmp/responder-setup.sh");
    expect(sandbox.snapshot).toHaveBeenCalledWith({ expiration: 0 });
    expect(dependencies.complete).toHaveBeenCalledWith(
      organizationId,
      key,
      { ...base, builtSnapshotId: "snap_new", startCommand: settings.startCommand },
      expect.stringContaining("Built snapshot snap_new."),
    );
  });

  it("records a failing setup script without throwing", async () => {
    const { sandbox } = fakeSandbox("responder-setup.sh");
    const dependencies = buildDependencies({ sandbox });
    await expect(buildSandboxImage(organizationId, {}, environment, dependencies))
      .resolves.toBe("failed");
    expect(dependencies.fail).toHaveBeenCalledWith(
      organizationId,
      sandboxImageKey(settings, base),
      "setup script exited with code 1",
      expect.stringContaining("$ setup script"),
    );
    expect(sandbox.snapshot).not.toHaveBeenCalled();
    expect(sandbox.stop).toHaveBeenCalled();
  });

  it("queues a snapshot it could not record for deletion", async () => {
    const { sandbox } = fakeSandbox();
    const dependencies = buildDependencies({ sandbox });
    dependencies.complete.mockRejectedValue(new Error("database unavailable"));
    await expect(buildSandboxImage(organizationId, {}, environment, dependencies))
      .rejects.toThrow("database unavailable");
    expect(dependencies.queueDeletion).toHaveBeenCalledWith("snap_new");
  });

  it("stops the sandbox and leaves the image building when the worker shuts down", async () => {
    const { sandbox } = fakeSandbox();
    const shutdown = new AbortController();
    sandbox.runCommand.mockImplementationOnce(async () => {
      shutdown.abort();
      return { wait: async () => ({ exitCode: 1, output: async () => "killed\n" }) };
    });
    const dependencies = buildDependencies({ sandbox });
    await expect(buildSandboxImage(organizationId, { signal: shutdown.signal }, environment, dependencies))
      .resolves.toBe("interrupted");
    expect(sandbox.stop).toHaveBeenCalled();
    expect(dependencies.fail).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
  });

  it("leaves the image building when its sandbox fails to start while the worker shuts down", async () => {
    const shutdown = new AbortController();
    const dependencies = buildDependencies({});
    dependencies.createSandbox.mockImplementationOnce(async () => {
      shutdown.abort();
      throw new Error("connection reset");
    });
    await expect(buildSandboxImage(organizationId, { signal: shutdown.signal }, environment, dependencies))
      .resolves.toBe("interrupted");
    expect(dependencies.fail).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
  });

  it("leaves the image building without a sandbox once the worker is shutting down", async () => {
    const shutdown = new AbortController();
    const dependencies = buildDependencies({});
    dependencies.start.mockImplementationOnce(async () => {
      shutdown.abort();
    });
    await expect(buildSandboxImage(organizationId, { signal: shutdown.signal }, environment, dependencies))
      .resolves.toBe("interrupted");
    expect(dependencies.createSandbox).not.toHaveBeenCalled();
    expect(dependencies.fail).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
  });

  it("does not rebuild a snapshot that matches the settings", async () => {
    const dependencies = buildDependencies({ image: image() });
    await expect(buildSandboxImage(organizationId, {}, environment, dependencies))
      .resolves.toBe("current");
    expect(dependencies.createSandbox).not.toHaveBeenCalled();
  });

  it("records a new start command with the snapshot without rebuilding", async () => {
    const dependencies = buildDependencies({ image: image({ snapshotStartCommand: "echo previous" }) });
    await expect(buildSandboxImage(organizationId, {}, environment, dependencies))
      .resolves.toBe("current");
    expect(dependencies.createSandbox).not.toHaveBeenCalled();
    expect(dependencies.complete).toHaveBeenCalledWith(
      organizationId,
      sandboxImageKey(settings, base),
      { ...base, builtSnapshotId: "snap_workspace", startCommand: settings.startCommand },
      "",
    );
  });

  it("rebuilds a matching snapshot when an admin asked after it last built", async () => {
    const { sandbox } = fakeSandbox();
    const dependencies = buildDependencies({
      image: image(),
      rebuildRequestedAt: new Date("2026-11-03T13:00:00Z"),
      sandbox,
    });
    await expect(buildSandboxImage(organizationId, {}, environment, dependencies))
      .resolves.toBe("built");
  });

  it("forgets the image once the workspace adds nothing", async () => {
    const dependencies = buildDependencies({ settings: defaultSandboxImageSettings });
    await expect(buildSandboxImage(organizationId, {}, environment, dependencies))
      .resolves.toBe("cleared");
    expect(dependencies.clear).toHaveBeenCalledWith(organizationId);
  });

  it("does nothing on Daytona", async () => {
    const dependencies = buildDependencies({});
    await expect(buildSandboxImage(
      organizationId,
      {},
      { DAYTONA_API_KEY: "key", SANDBOX_PROVIDER: "daytona" },
      dependencies,
    )).resolves.toBe("unsupported");
    expect(dependencies.getSettings).not.toHaveBeenCalled();
  });
});

describe("sandbox image maintenance", () => {
  function maintenanceDependencies(
    workspaces: Array<{
      image: SandboxImageRecord | null;
      organizationId: string;
      rebuildRequestedAt?: Date | null;
      settings: SandboxImageSettings;
    }>,
    deletions: Array<{ attempts: number; snapshotId: string }> = [],
  ) {
    return {
      deleteSnapshot: vi.fn(async (_config: VercelSandboxConfig, snapshotId: string) => {
        if (snapshotId === "snap_stuck") throw new Error("Vercel unavailable");
      }),
      finishDeletion: vi.fn(async () => undefined),
      listDeletions: vi.fn(async () => deletions),
      listWorkspaces: vi.fn(async () => workspaces.map((workspace) => ({
        rebuildRequestedAt: null,
        ...workspace,
      }))),
      retryDeletion: vi.fn(async () => undefined),
    };
  }

  it("queues workspaces whose image is out of date, cut off, asked for, has a new start command, or is left behind", async () => {
    const queue = vi.fn<(organizationId: string) => Promise<boolean>>(async () => true);
    const dependencies = maintenanceDependencies([
      { image: image(), organizationId: "current", settings },
      { image: image({ key: "old-base" }), organizationId: "outdated", settings },
      { image: null, organizationId: "new", settings },
      { image: image({ status: "building" }), organizationId: "cut-off", settings },
      {
        image: image({ snapshotStartCommand: "echo previous" }),
        organizationId: "start-command",
        settings,
      },
      {
        image: image(),
        organizationId: "rebuild",
        rebuildRequestedAt: new Date("2026-11-03T13:00:00Z"),
        settings,
      },
      { image: image(), organizationId: "cleared", settings: defaultSandboxImageSettings },
      { image: null, organizationId: "unused", settings: defaultSandboxImageSettings },
    ]);
    const result = await maintainSandboxImages(queue, environment, dependencies);
    expect(result.queued).toBe(6);
    expect(queue.mock.calls.map(([id]) => id)).toEqual([
      "outdated",
      "new",
      "cut-off",
      "start-command",
      "rebuild",
      "cleared",
    ]);
  });

  it("keeps going when queueing one workspace fails, and counts only new jobs", async () => {
    const queue = vi.fn<(organizationId: string) => Promise<boolean>>(async (organizationId) => {
      if (organizationId === "broken") throw new Error("queue unavailable");
      return organizationId !== "already-queued";
    });
    const dependencies = maintenanceDependencies([
      { image: null, organizationId: "broken", settings },
      { image: null, organizationId: "already-queued", settings },
      { image: null, organizationId: "new", settings },
    ], [{ attempts: 0, snapshotId: "snap_old" }]);
    await expect(maintainSandboxImages(queue, environment, dependencies))
      .resolves.toEqual({ deleted: 1, queued: 1 });
  });

  it("deletes due snapshots and retries a failed deletion later", async () => {
    const now = new Date("2026-11-03T15:00:00Z");
    const dependencies = maintenanceDependencies([], [
      { attempts: 0, snapshotId: "snap_old" },
      { attempts: 2, snapshotId: "snap_stuck" },
    ]);
    const result = await maintainSandboxImages(async () => true, environment, dependencies, now);
    expect(result.deleted).toBe(1);
    expect(dependencies.finishDeletion).toHaveBeenCalledWith("snap_old");
    expect(dependencies.retryDeletion).toHaveBeenCalledWith(
      "snap_stuck",
      "Vercel unavailable",
      new Date(now.getTime() + 20 * 60 * 1_000),
    );
  });
});

describe("sandbox start command", () => {
  function session(output: string) {
    return { execCommand: vi.fn(async () => output) } as unknown as SandboxSession & {
      execCommand: ReturnType<typeof vi.fn>;
    };
  }

  it("runs the command with its output in a file", async () => {
    const started = session("Process exited with code 0\nOutput:\n");
    await runSandboxStartCommand(started, "sudo dockerd &");
    expect(started.execCommand).toHaveBeenCalledWith(expect.objectContaining({
      cmd: expect.stringContaining("timeout 300 bash -eo pipefail -c 'sudo dockerd &' >/tmp/responder-start-command.log 2>&1 </dev/null"),
    }));
  });

  it("fails the run with the command's output", async () => {
    await expect(runSandboxStartCommand(
      session("Process exited with code 1\nOutput:\nservice: not found"),
      "service docker start",
    )).rejects.toThrow("The workspace sandbox start command failed: service: not found");
  });

  it("skips an empty command", async () => {
    const started = session("");
    await runSandboxStartCommand(started, "");
    expect(started.execCommand).not.toHaveBeenCalled();
  });
});
