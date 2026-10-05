import {
  Daytona,
  type Sandbox,
} from "@daytona/sdk";
import type {
  DaytonaSandboxClient,
  DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import {
  daytonaClientOptions,
  isDaytonaNotFound,
  type DaytonaClientConfig,
} from "@responder/core/daytona-config";
import { reportWorkerException, type WorkerErrorContext } from "./monitoring.js";

type DaytonaCleanupConfig = DaytonaClientConfig;

export interface DaytonaSandboxSecretMount {
  environmentVariable: string;
  daytonaSecretName: string;
}

interface DaytonaCleanupClient {
  delete(sandbox: Sandbox, timeout?: number, wait?: boolean): Promise<void>;
  get(sandboxIdOrName: string): Promise<Sandbox>;
  [Symbol.asyncDispose](): Promise<void>;
}

type DaytonaSandboxCreator = Pick<DaytonaSandboxClient, "create">;

export interface DaytonaCleanupDependencies {
  createClient(config: DaytonaCleanupConfig): DaytonaCleanupClient;
  reportException: typeof reportWorkerException;
  sleep(delayMs: number): Promise<void>;
}

const defaultCleanupDependencies: DaytonaCleanupDependencies = {
  createClient: (config) => new Daytona(daytonaClientOptions(config)),
  reportException: reportWorkerException,
  sleep: (delayMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }),
};

const daytonaRetryDelaysMs = [0, 500, 1_500] as const;
const daytonaAppearanceRetryDelaysMs = [
  0,
  500,
  1_500,
  3_000,
  5_000,
  10_000,
  10_000,
] as const;
const daytonaStartAttempts = 2;
const daytonaStartRetryDelayMs = 5_000;

// Daytona returns this when the runner it picked cannot start the container,
// for example when the runner's container runtime is broken. A new attempt
// can be placed on a healthy runner.
function isDaytonaStartFailure(error: unknown): boolean {
  return error instanceof Error &&
    error.message.includes("Sandbox failed to start");
}

// Creation errors thrown after the failed sandbox was confirmed deleted.
const creationErrorsWithDeletedSandbox = new WeakSet<object>();

export function sandboxDeletedAfterFailedCreation(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    creationErrorsWithDeletedSandbox.has(error);
}

function isTransientDaytonaError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = error.statusCode;
    if (
      typeof statusCode === "number" &&
      (statusCode === 408 || statusCode === 429 || statusCode >= 500)
    ) {
      return true;
    }
  }
  return (
    error instanceof Error &&
    [
      "DaytonaBadGatewayError",
      "DaytonaConnectionError",
      "DaytonaConnectionTimeoutError",
      "DaytonaInternalServerError",
      "DaytonaRateLimitError",
      "DaytonaServiceUnavailableError",
      "DaytonaTimeoutError",
    ].includes(error.name)
  );
}

async function retryTransientDaytonaOperation<T>(
  operation: () => Promise<T>,
  dependencies: DaytonaCleanupDependencies,
): Promise<T> {
  let lastError: unknown;
  for (const delayMs of daytonaRetryDelaysMs) {
    if (delayMs > 0) await dependencies.sleep(delayMs);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientDaytonaError(error)) throw error;
    }
  }
  throw lastError;
}

async function deleteDaytonaSandboxByReference(
  reference: string,
  config: DaytonaCleanupConfig,
  waitForAppearance: boolean,
  dependencies: DaytonaCleanupDependencies,
): Promise<void> {
  const client = dependencies.createClient(config);
  const retryDelays = waitForAppearance
    ? daytonaAppearanceRetryDelaysMs
    : daytonaRetryDelaysMs;
  try {
    for (const [index, delayMs] of retryDelays.entries()) {
      if (delayMs > 0) await dependencies.sleep(delayMs);
      try {
        const sandbox = await client.get(reference);
        await client.delete(sandbox, 60, true);
        return;
      } catch (error) {
        if (isDaytonaNotFound(error)) {
          if (waitForAppearance && index < retryDelays.length - 1) {
            continue;
          }
          if (waitForAppearance) {
            const cleanupError = new Error(
              `Sandbox ${reference} did not appear before cleanup timed out`,
            );
            await dependencies.reportException(cleanupError, {
              operation: "sandbox_cleanup",
              sandboxId: reference,
            });
            console.error(JSON.stringify({
              event: "daytona_pending_sandbox_not_found",
              sandboxId: reference,
            }));
            throw cleanupError;
          }
          return;
        }
        if (
          !isTransientDaytonaError(error) ||
          index === daytonaRetryDelaysMs.length - 1
        ) {
          throw error;
        }
      }
    }
  } finally {
    await client[Symbol.asyncDispose]().catch(() => undefined);
  }
}

export async function deleteDaytonaSandboxByName(
  sandboxName: string,
  config: DaytonaCleanupConfig,
  dependencies: DaytonaCleanupDependencies = defaultCleanupDependencies,
): Promise<void> {
  await deleteDaytonaSandboxByReference(
    sandboxName,
    config,
    true,
    dependencies,
  );
}

export async function createDaytonaSandboxSession(
  creator: DaytonaSandboxCreator,
  config: DaytonaCleanupConfig,
  sandboxName: string,
  dependencies: DaytonaCleanupDependencies = defaultCleanupDependencies,
  // Stops a retry from creating a sandbox after the caller has given up.
  signal?: AbortSignal,
): Promise<DaytonaSandboxSession> {
  await deleteDaytonaSandboxByReference(
    sandboxName,
    config,
    false,
    dependencies,
  );
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await creator.create();
    } catch (createError) {
      try {
        await deleteDaytonaSandboxByReference(
          sandboxName,
          config,
          true,
          dependencies,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [createError, cleanupError],
          `Unable to create or clean up Daytona sandbox ${sandboxName}`,
        );
      }
      if (typeof createError === "object" && createError !== null) {
        creationErrorsWithDeletedSandbox.add(createError);
      }
      if (
        attempt >= daytonaStartAttempts ||
        !isDaytonaStartFailure(createError) ||
        signal?.aborted
      ) {
        throw createError;
      }
      console.error(JSON.stringify({
        event: "daytona_sandbox_start_retry",
        sandboxId: sandboxName,
      }));
      await dependencies.sleep(daytonaStartRetryDelayMs);
      if (signal?.aborted) throw createError;
    }
  }
}

export async function configureDaytonaSandboxLifecycle(
  session: DaytonaSandboxSession,
  config: DaytonaCleanupConfig,
  secrets: DaytonaSandboxSecretMount[] = [],
  lifecycleOrDependencies: number | DaytonaCleanupDependencies =
    defaultCleanupDependencies,
  persistentDependencies: DaytonaCleanupDependencies = defaultCleanupDependencies,
): Promise<void> {
  const autoDeleteInterval = typeof lifecycleOrDependencies === "number"
    ? lifecycleOrDependencies
    : 0;
  const dependencies = typeof lifecycleOrDependencies === "number"
    ? persistentDependencies
    : lifecycleOrDependencies;
  const client = dependencies.createClient(config);
  try {
    const sandbox = await retryTransientDaytonaOperation(
      () => client.get(session.state.sandboxId),
      dependencies,
    );
    if (secrets.length > 0) {
      await retryTransientDaytonaOperation(
        () =>
          sandbox.updateSecrets(
            Object.fromEntries(
              secrets.map((secret) => [
                secret.environmentVariable,
                secret.daytonaSecretName,
              ]),
            ),
          ),
        dependencies,
      );
      await retryTransientDaytonaOperation(() => sandbox.stop(), dependencies);
      await retryTransientDaytonaOperation(() => sandbox.start(), dependencies);
    }
    await retryTransientDaytonaOperation(
      () => sandbox.setAutoDeleteInterval(autoDeleteInterval),
      dependencies,
    );
  } finally {
    await client[Symbol.asyncDispose]().catch(() => undefined);
  }
}

// Mounts exactly these secrets, detaching any others, then restarts the
// sandbox so a sandbox that had none can use them.
export async function replaceDaytonaSandboxSecrets(
  session: DaytonaSandboxSession,
  config: DaytonaCleanupConfig,
  secrets: DaytonaSandboxSecretMount[],
  dependencies: DaytonaCleanupDependencies = defaultCleanupDependencies,
): Promise<void> {
  const client = dependencies.createClient(config);
  try {
    const sandbox = await retryTransientDaytonaOperation(
      () => client.get(session.state.sandboxId),
      dependencies,
    );
    await retryTransientDaytonaOperation(
      () => sandbox.updateSecrets(Object.fromEntries(
        secrets.map((secret) => [secret.environmentVariable, secret.daytonaSecretName]),
      )),
      dependencies,
    );
    await retryTransientDaytonaOperation(() => sandbox.stop(), dependencies);
    await retryTransientDaytonaOperation(() => sandbox.start(), dependencies);
  } finally {
    await client[Symbol.asyncDispose]().catch(() => undefined);
  }
}

// A thread sandbox that fails to stop keeps running until Daytona's
// auto-stop, and the next turn resumes or replaces it. The failure is
// reported without failing the turn that already has its answer.
export async function pauseDaytonaSandbox(
  session: DaytonaSandboxSession,
  context: Omit<WorkerErrorContext, "operation" | "sandboxId">,
  dependencies: Pick<DaytonaCleanupDependencies, "reportException"> =
    defaultCleanupDependencies,
): Promise<void> {
  const sandboxId = session.state.sandboxId;
  try {
    await session.close();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "daytona_sandbox_pause_failed",
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

/**
 * Install the small set of tools needed by agents when no prebuilt snapshot
 * is configured. Named snapshots already contain these tools and skip this.
 */
export async function prepareDaytonaSandbox(
  session: DaytonaSandboxSession,
): Promise<void> {
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      "if command -v curl >/dev/null 2>&1 && command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && command -v rg >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1 && command -v bun >/dev/null 2>&1; then exit 0; fi",
      "if ! command -v apt-get >/dev/null 2>&1; then echo 'curl, git, Node.js, npm, Python 3, ripgrep, unzip, or Bun is unavailable and apt-get is missing' >&2; exit 1; fi",
      "if [ \"$(id -u)\" -eq 0 ]; then",
      "  apt-get update -qq",
      "  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl git nodejs npm python3 ripgrep unzip",
      "  if ! command -v bun >/dev/null 2>&1; then curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash; fi",
      "elif command -v sudo >/dev/null 2>&1; then",
      "  sudo apt-get update -qq",
      "  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl git nodejs npm python3 ripgrep unzip",
      "  if ! command -v bun >/dev/null 2>&1; then curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash; fi",
      "else",
      "  echo 'curl, git, Node.js, npm, Python 3, ripgrep, unzip, and Bun installation require root access' >&2",
      "  exit 1",
      "fi",
      "command -v curl >/dev/null",
      "command -v git >/dev/null",
      "command -v node >/dev/null",
      "command -v npm >/dev/null",
      "command -v python3 >/dev/null",
      "command -v rg >/dev/null",
      "command -v unzip >/dev/null",
      "command -v bun >/dev/null",
    ].join("\n"),
    maxOutputTokens: 2_000,
    workdir: "/home/daytona/workspace",
  });
  if (!execSucceeded(output)) {
    const detail = output.split("\nOutput:\n", 2)[1]?.trim();
    throw new Error(
      `Unable to install curl, git, Node.js, npm, Python 3, ripgrep, unzip, and Bun in Daytona${detail ? `: ${detail}` : ""}`,
    );
  }
}

/** Prepare only the tools needed to apply and publish a proposed diff. */
export async function prepareDaytonaPatchSandbox(
  session: DaytonaSandboxSession,
): Promise<void> {
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      "if command -v git >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then exit 0; fi",
      "if ! command -v apt-get >/dev/null 2>&1; then echo 'git or tar is unavailable and apt-get is missing' >&2; exit 1; fi",
      "if [ \"$(id -u)\" -eq 0 ]; then",
      "  apt-get update -qq",
      "  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git tar",
      "elif command -v sudo >/dev/null 2>&1; then",
      "  sudo apt-get update -qq",
      "  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git tar",
      "else",
      "  echo 'git and tar installation require root access' >&2",
      "  exit 1",
      "fi",
      "command -v git >/dev/null",
      "command -v tar >/dev/null",
    ].join("\n"),
    maxOutputTokens: 2_000,
    workdir: "/home/daytona/workspace",
  });
  if (!execSucceeded(output)) {
    const detail = output.split("\nOutput:\n", 2)[1]?.trim();
    throw new Error(
      `Unable to install git and tar in Daytona${detail ? `: ${detail}` : ""}`,
    );
  }
}
