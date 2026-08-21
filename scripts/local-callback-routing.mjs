import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function outermostGitRepository() {
  let directory = realpathSync(process.cwd());
  let repository = null;

  while (true) {
    if (existsSync(join(directory, ".git"))) repository = directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  if (!repository) {
    throw new Error("Local callback routing requires a Git repository.");
  }
  return repository;
}

export function callbackTargetFile() {
  const gitCommonDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: outermostGitRepository(),
      encoding: "utf8",
    },
  ).trim();
  return join(gitCommonDirectory, "responder", "callback-target.json");
}

export function validCallbackTarget(value) {
  if (!value || typeof value !== "object") return null;

  try {
    const origin = new URL(value.origin);
    if (
      origin.protocol !== "http:" ||
      !loopbackHosts.has(origin.hostname) ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password ||
      !origin.port
    ) {
      return null;
    }

    const browserOrigin = value.browserOrigin
      ? new URL(value.browserOrigin)
      : null;
    if (
      browserOrigin &&
      (browserOrigin.protocol !== "https:" ||
        browserOrigin.pathname !== "/" ||
        browserOrigin.search ||
        browserOrigin.hash ||
        browserOrigin.username ||
        browserOrigin.password)
    ) {
      return null;
    }

    return {
      ...(browserOrigin ? { browserOrigin: browserOrigin.origin } : {}),
      origin: origin.origin,
      workspace:
        typeof value.workspace === "string" ? value.workspace : "unknown",
      updatedAt:
        typeof value.updatedAt === "string" ? value.updatedAt : "unknown",
    };
  } catch {
    return null;
  }
}

export function readCallbackTarget() {
  try {
    return validCallbackTarget(
      JSON.parse(readFileSync(callbackTargetFile(), "utf8")),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function writeCallbackTarget(target) {
  const validTarget = validCallbackTarget(target);
  if (!validTarget) throw new Error("Refusing to store an invalid callback target.");

  const targetFile = callbackTargetFile();
  const temporaryFile = join(
    dirname(targetFile),
    `.${basename(targetFile)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  mkdirSync(dirname(targetFile), { recursive: true });

  try {
    writeFileSync(temporaryFile, `${JSON.stringify(validTarget, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryFile, targetFile);
  } finally {
    rmSync(temporaryFile, { force: true });
  }

  return validTarget;
}

export function clearCallbackTarget() {
  rmSync(callbackTargetFile(), { force: true });
}
