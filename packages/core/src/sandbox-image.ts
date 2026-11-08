import { createHash } from "node:crypto";
import { z } from "zod";

// A workspace can add system packages and a setup script to its sandboxes.
// They are built once into a snapshot of the workspace's own, on top of the
// cell's base snapshot, so a run starts with them already installed. A start
// command runs in every sandbox as it starts or resumes, for processes a
// snapshot cannot keep, such as the Docker daemon. With a snapshot, the start
// command is recorded with it and changes when the snapshot does, so a run
// never runs a start command its snapshot was not built for. A workspace can
// also have each checked-out repository's dependencies installed after
// checkout, which needs no snapshot.

export interface SandboxImageSettings {
  installDependencies: boolean;
  packages: string[];
  setupScript: string;
  startCommand: string;
  vcpus: number;
}

// Vercel gives each vCPU 2 GiB of memory.
export const sandboxVcpuOptions = [2, 4, 8] as const;
export const sandboxMemoryGiBPerVcpu = 2;
export const defaultSandboxVcpus = 2;

export const defaultSandboxImageSettings: SandboxImageSettings = {
  installDependencies: false,
  packages: [],
  setupScript: "",
  startCommand: "",
  vcpus: defaultSandboxVcpus,
};

export const maxSandboxPackages = 100;
export const maxSandboxScriptLength = 20_000;

// dnf package names and specs such as postgresql16-server or python3.12.
export const sandboxPackageSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u,
    "Use package names such as postgresql16-server, without spaces or options",
  );

export const sandboxImageSettingsSchema = z.object({
  // Optional, so a settings page loaded before this setting existed still saves.
  installDependencies: z.boolean().default(false),
  packages: z
    .array(sandboxPackageSchema)
    .transform((packages) => [...new Set(packages)])
    .refine(
      (packages) => packages.length <= maxSandboxPackages,
      `Add at most ${maxSandboxPackages} packages`,
    ),
  setupScript: z.string().max(maxSandboxScriptLength).transform((script) => script.trim()),
  startCommand: z.string().max(maxSandboxScriptLength).transform((script) => script.trim()),
  vcpus: z.number().int().refine(
    (vcpus) => (sandboxVcpuOptions as readonly number[]).includes(vcpus),
    `Choose ${sandboxVcpuOptions.join(", ")} vCPUs`,
  ),
});

// Only packages and the setup script go into the snapshot.
export function sandboxImageRequired(settings: SandboxImageSettings): boolean {
  return settings.packages.length > 0 || settings.setupScript.length > 0;
}

// The base a workspace snapshot is built on.
export interface SandboxImageBase {
  region: string;
  snapshotId: string;
}

// Bump to rebuild every workspace snapshot after the build steps change.
const sandboxImageBuildVersion = 1;

// Identifies a build: a snapshot built from the same base, packages, and
// script is the same, and any change needs a new one.
export function sandboxImageKey(
  settings: Pick<SandboxImageSettings, "packages" | "setupScript">,
  base: SandboxImageBase,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      sandboxImageBuildVersion,
      base.region,
      base.snapshotId,
      [...settings.packages].sort(),
      settings.setupScript,
    ]))
    .digest("hex")
    .slice(0, 16);
}

export type SandboxImageStatus = "building" | "failed" | "ready";

export interface SandboxImageRecord {
  // The build last started, and how it went.
  key: string;
  status: SandboxImageStatus;
  error: string | null;
  log: string;
  startedAt: Date;
  finishedAt: Date | null;
  // The last snapshot that built, which may be from an earlier key.
  snapshotId: string | null;
  snapshotKey: string | null;
  snapshotBaseId: string | null;
  snapshotRegion: string | null;
  snapshotBuiltAt: Date | null;
  // The start command saved with the settings the snapshot was built from.
  snapshotStartCommand: string | null;
}

// The snapshot a run starts from. An exact build is best. While a changed
// script or package list builds, the previous snapshot on the same base still
// has most of what the workspace needs. A snapshot on an older base is not
// used, because it lacks the current agent harnesses and fixes.
export function sandboxImageSnapshotFor(
  settings: SandboxImageSettings,
  image: SandboxImageRecord | null,
  base: SandboxImageBase,
): string | null {
  if (!sandboxImageRequired(settings) || !image?.snapshotId) return null;
  if (image.snapshotKey === sandboxImageKey(settings, base)) return image.snapshotId;
  return image.snapshotBaseId === base.snapshotId && image.snapshotRegion === base.region
    ? image.snapshotId
    : null;
}

// The start command for a run: the one recorded with the snapshot it starts
// from, none when it starts from the base snapshot without the workspace's
// packages, and the saved one when the workspace needs no snapshot.
export function sandboxImageStartCommand(
  settings: SandboxImageSettings,
  image: Pick<SandboxImageRecord, "snapshotId" | "snapshotStartCommand"> | null,
  snapshotId: string | null,
): string {
  if (!sandboxImageRequired(settings)) return settings.startCommand;
  if (!snapshotId || image?.snapshotId !== snapshotId) return "";
  return image.snapshotStartCommand ?? "";
}
