import { describe, expect, it } from "vitest";
import {
  defaultSandboxImageSettings,
  sandboxImageKey,
  sandboxImageSettingsSchema,
  sandboxImageSnapshotFor,
  type SandboxImageRecord,
} from "./sandbox-image.js";

const base = { region: "cdg1", snapshotId: "snap_base" };
const settings = {
  ...defaultSandboxImageSettings,
  packages: ["ffmpeg", "valkey"],
  setupScript: "npx -y playwright install chromium",
};

function image(overrides: Partial<SandboxImageRecord> = {}): SandboxImageRecord {
  return {
    error: null,
    finishedAt: new Date("2026-11-03T12:00:00Z"),
    key: sandboxImageKey(settings, base),
    log: "",
    snapshotBaseId: base.snapshotId,
    snapshotBuiltAt: new Date("2026-11-03T12:00:00Z"),
    snapshotId: "snap_workspace",
    snapshotKey: sandboxImageKey(settings, base),
    snapshotRegion: base.region,
    startedAt: new Date("2026-11-03T11:55:00Z"),
    status: "ready",
    ...overrides,
  };
}

describe("sandbox image settings", () => {
  it("trims scripts and drops repeated packages", () => {
    expect(sandboxImageSettingsSchema.parse({
      packages: ["ffmpeg", "ffmpeg", "valkey"],
      setupScript: "  echo hi \n",
      startCommand: "",
      vcpus: 4,
    })).toEqual({ packages: ["ffmpeg", "valkey"], setupScript: "echo hi", startCommand: "", vcpus: 4 });
  });

  it("rejects a package with options or a second command", () => {
    for (const name of ["--nogpgcheck", "ffmpeg; curl evil.sh", "a b"]) {
      expect(sandboxImageSettingsSchema.safeParse({
        ...defaultSandboxImageSettings,
        packages: [name],
      }).success).toBe(false);
    }
  });

  it("allows only the offered sandbox sizes", () => {
    expect(sandboxImageSettingsSchema.safeParse({ ...defaultSandboxImageSettings, vcpus: 3 }).success)
      .toBe(false);
  });
});

describe("sandbox image key", () => {
  it("ignores package order but not the base or script", () => {
    const key = sandboxImageKey(settings, base);
    expect(sandboxImageKey({ ...settings, packages: ["valkey", "ffmpeg"] }, base)).toBe(key);
    expect(sandboxImageKey(settings, { ...base, snapshotId: "snap_next" })).not.toBe(key);
    expect(sandboxImageKey(settings, { ...base, region: "pdx1" })).not.toBe(key);
    expect(sandboxImageKey({ ...settings, setupScript: "true" }, base)).not.toBe(key);
  });
});

describe("sandbox image snapshot", () => {
  it("uses the workspace snapshot that matches its settings", () => {
    expect(sandboxImageSnapshotFor(settings, image(), base)).toBe("snap_workspace");
  });

  it("keeps the previous snapshot on the same base while a change builds", () => {
    const changed = { ...settings, packages: [...settings.packages, "jq"] };
    expect(sandboxImageSnapshotFor(changed, image({ status: "building" }), base))
      .toBe("snap_workspace");
  });

  it("drops a snapshot built on an older base", () => {
    expect(sandboxImageSnapshotFor(settings, image(), { ...base, snapshotId: "snap_next" }))
      .toBeNull();
  });

  it("uses the base when the workspace adds nothing", () => {
    expect(sandboxImageSnapshotFor(defaultSandboxImageSettings, image(), base)).toBeNull();
  });
});
