import {
  Daytona,
  DaytonaNotFoundError,
  type Sandbox,
} from "@daytonaio/sdk";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { reportWorkerException, type WorkerErrorContext } from "./monitoring.js";

interface DaytonaCleanupConfig {
  daytonaApiKey: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
}

export interface DaytonaSandboxSecretMount {
  environmentVariable: string;
  daytonaSecretName: string;
}

interface DaytonaCleanupClient {
  delete(sandbox: Sandbox, timeout?: number, wait?: boolean): Promise<void>;
  get(sandboxIdOrName: string): Promise<Sandbox>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface DaytonaCleanupDependencies {
  createClient(config: DaytonaCleanupConfig): DaytonaCleanupClient;
  reportException: typeof reportWorkerException;
  sleep(delayMs: number): Promise<void>;
}

const defaultCleanupDependencies: DaytonaCleanupDependencies = {
  createClient: (config) =>
    new Daytona({
      apiKey: config.daytonaApiKey,
      apiUrl: config.daytonaApiUrl,
      target: config.daytonaTarget,
    }),
  reportException: reportWorkerException,
  sleep: (delayMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }),
};

export async function configureDaytonaSandboxLifecycle(
  session: DaytonaSandboxSession,
  config: DaytonaCleanupConfig,
  secrets: DaytonaSandboxSecretMount[] = [],
  dependencies: DaytonaCleanupDependencies = defaultCleanupDependencies,
): Promise<void> {
  const client = dependencies.createClient(config);
  try {
    const sandbox = await client.get(session.state.sandboxId);
    if (secrets.length > 0) {
      await sandbox.updateSecrets(
        Object.fromEntries(
          secrets.map((secret) => [
            secret.environmentVariable,
            secret.daytonaSecretName,
          ]),
        ),
      );
      await sandbox.stop();
      await sandbox.start();
    }
    await sandbox.setAutoDeleteInterval(0);
  } finally {
    await client[Symbol.asyncDispose]().catch(() => undefined);
  }
}

function isDaytonaNotFound(error: unknown): boolean {
  return (
    error instanceof DaytonaNotFoundError ||
    (typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404)
  );
}

export async function closeDaytonaSandbox(
  session: DaytonaSandboxSession,
  config: DaytonaCleanupConfig,
  context: Omit<WorkerErrorContext, "operation" | "sandboxId">,
  dependencies: DaytonaCleanupDependencies = defaultCleanupDependencies,
): Promise<void> {
  const sandboxId = session.state.sandboxId;
  let closeError: unknown;

  try {
    await session.close();
  } catch (error) {
    closeError = error;
  }

  let client: DaytonaCleanupClient | undefined;
  let cleanupError: unknown;
  try {
    client = dependencies.createClient(config);
    for (const delayMs of [0, 500, 1_500]) {
      if (delayMs > 0) await dependencies.sleep(delayMs);
      try {
        const sandbox = await client.get(sandboxId);
        await client.delete(sandbox, 60, true);
        cleanupError = undefined;
        break;
      } catch (error) {
        if (isDaytonaNotFound(error)) {
          cleanupError = undefined;
          break;
        }
        cleanupError = error;
      }
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    await client?.[Symbol.asyncDispose]().catch(() => undefined);
  }

  if (!cleanupError) return;

  const error = new AggregateError(
    [closeError, cleanupError].filter((failure) => failure !== undefined),
    `Unable to delete Daytona sandbox ${sandboxId}`,
  );
  console.error(
    JSON.stringify({
      error: error.message,
      event: "daytona_sandbox_cleanup_failed",
      sandboxId,
      ...context,
    }),
  );
  await dependencies.reportException(error, {
    operation: "sandbox_cleanup",
    sandboxId,
    ...context,
  });
}

function execSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

export async function prepareDaytonaSandbox(
  session: DaytonaSandboxSession,
): Promise<void> {
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      "if command -v git >/dev/null 2>&1 && command -v rg >/dev/null 2>&1; then exit 0; fi",
      "if ! command -v apt-get >/dev/null 2>&1; then echo 'git or ripgrep is unavailable and apt-get is missing' >&2; exit 1; fi",
      "if [ \"$(id -u)\" -eq 0 ]; then",
      "  apt-get update -qq",
      "  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ripgrep",
      "elif command -v sudo >/dev/null 2>&1; then",
      "  sudo apt-get update -qq",
      "  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ripgrep",
      "else",
      "  echo 'git and ripgrep installation require root access' >&2",
      "  exit 1",
      "fi",
      "command -v git >/dev/null",
      "command -v rg >/dev/null",
    ].join("\n"),
    maxOutputTokens: 2_000,
    workdir: "/home/daytona/workspace",
  });
  if (!execSucceeded(output)) {
    const detail = output.split("\nOutput:\n", 2)[1]?.trim();
    throw new Error(
      `Unable to install git and ripgrep in Daytona${detail ? `: ${detail}` : ""}`,
    );
  }
}
