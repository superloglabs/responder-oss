import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function callbackTargetFile() {
  if (process.env.RESPONDER_CALLBACK_TARGET_FILE) {
    return resolve(process.env.RESPONDER_CALLBACK_TARGET_FILE);
  }

  const gitCommonDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
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

    return {
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
  const temporaryFile = `${targetFile}.${process.pid}.tmp`;
  mkdirSync(dirname(targetFile), { recursive: true });

  try {
    writeFileSync(temporaryFile, `${JSON.stringify(validTarget, null, 2)}\n`, {
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
