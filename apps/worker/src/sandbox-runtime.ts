import { DaytonaSandboxClient } from "@openai/agents-extensions/sandbox/daytona";
import type {
  DaytonaSandboxClient as DaytonaClient,
  DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import type {
  VercelSandboxClient,
  VercelSandboxSession,
} from "@openai/agents-extensions/sandbox/vercel";
import { daytonaClientOptions } from "@responder/core/daytona-config";
import type { SandboxConfig } from "@responder/core/sandbox-config";
import type { SandboxNetwork } from "@responder/core/sandbox-network";
import { reportWorkerException, type WorkerErrorContext } from "./monitoring.js";
import {
  applyDaytonaSandboxNetwork,
  closeDaytonaSandbox,
  configureDaytonaSandboxLifecycle,
  createDaytonaSandboxSession,
  deleteDaytonaSandboxByName,
  replaceDaytonaSandboxSecrets,
  resumeDaytonaSandbox,
  resumedSameDaytonaSandbox,
  type DaytonaCleanupDependencies,
} from "./sandbox.js";
import type { SandboxClient, SandboxSecretMount, SandboxSession } from "./sandbox-session.js";
import {
  applyVercelSandboxSecrets,
  captureVercelSandboxSnapshot,
  closeVercelSandbox,
  createVercelSandboxClient,
  createVercelSandboxSession,
  resumedSameVercelSandbox,
  resumeVercelSandbox,
} from "./vercel-sandbox.js";

export function createSandboxClient(
  config: SandboxConfig,
  options: { name: string; pauseOnExit: boolean },
): SandboxClient {
  return config.vercel
    ? createVercelSandboxClient(config, options)
    : new DaytonaSandboxClient({ ...daytonaClientOptions(config), ...options });
}

export function createSandboxSession(
  client: SandboxClient,
  config: SandboxConfig,
  sandboxName: string,
  dependencies?: DaytonaCleanupDependencies,
  signal?: AbortSignal,
  options: { keepPaused?: boolean } = {},
): Promise<SandboxSession> {
  return config.vercel
    ? createVercelSandboxSession(
      config,
      options.keepPaused ? "snapshot" : "tar",
      signal,
    )
    : createDaytonaSandboxSession(
      client as DaytonaClient,
      config,
      sandboxName,
      dependencies,
      signal,
    );
}

// Vercel sandboxes have no names, and a failed start leaves nothing behind.
export async function deleteSandboxByName(
  sandboxName: string,
  config: SandboxConfig,
): Promise<void> {
  if (!config.vercel) await deleteDaytonaSandboxByName(sandboxName, config);
}

function daytonaSecrets(
  secrets: SandboxSecretMount[],
): Array<{ daytonaSecretName: string; environmentVariable: string }> {
  return secrets.map(({ daytonaSecretName, environmentVariable }) => {
    if (!daytonaSecretName) {
      throw new Error(`Workspace secret ${environmentVariable} must be saved again before it can be used`);
    }
    return { daytonaSecretName, environmentVariable };
  });
}

export async function configureSandbox(
  session: SandboxSession,
  config: SandboxConfig,
  secrets: SandboxSecretMount[] = [],
  autoDeleteMinutes = 0,
  network: SandboxNetwork | null = null,
): Promise<void> {
  if (config.vercel) {
    await applyVercelSandboxSecrets(session as VercelSandboxSession, config, secrets, network);
    return;
  }
  await configureDaytonaSandboxLifecycle(
    session as DaytonaSandboxSession,
    config,
    daytonaSecrets(secrets),
    autoDeleteMinutes,
  );
  await applyDaytonaSandboxNetwork(session as DaytonaSandboxSession, config, network, secrets);
}

export async function replaceSandboxSecrets(
  session: SandboxSession,
  config: SandboxConfig,
  secrets: SandboxSecretMount[],
  network: SandboxNetwork | null = null,
): Promise<void> {
  if (config.vercel) {
    await applyVercelSandboxSecrets(session as VercelSandboxSession, config, secrets, network);
    return;
  }
  await replaceDaytonaSandboxSecrets(
    session as DaytonaSandboxSession,
    config,
    daytonaSecrets(secrets),
  );
  await applyDaytonaSandboxNetwork(session as DaytonaSandboxSession, config, network, secrets);
}

// For a resumed sandbox whose secrets are already mounted. Vercel drops its
// firewall rules on stop, so there this also mounts the secrets again.
export async function applySandboxNetwork(
  session: SandboxSession,
  config: SandboxConfig,
  secrets: SandboxSecretMount[],
  network: SandboxNetwork | null,
): Promise<void> {
  await (config.vercel
    ? applyVercelSandboxSecrets(session as VercelSandboxSession, config, secrets, network)
    : applyDaytonaSandboxNetwork(session as DaytonaSandboxSession, config, network, secrets));
}

export function resumeSandbox(
  client: SandboxClient,
  persistedState: Record<string, unknown>,
  config: SandboxConfig,
): Promise<SandboxSession> {
  // Callers start a fresh sandbox when this fails.
  if (Boolean(config.vercel) !== ("workspacePersistence" in persistedState)) {
    return Promise.reject(new Error("The sandbox was paused on another provider"));
  }
  return config.vercel
    ? resumeVercelSandbox(client as VercelSandboxClient, persistedState, config)
    : resumeDaytonaSandbox(client as DaytonaClient, persistedState, config);
}

export function resumedSameSandbox(
  session: SandboxSession,
  persistedState: Record<string, unknown>,
  config: SandboxConfig,
): boolean {
  return config.vercel
    ? resumedSameVercelSandbox(persistedState)
    : resumedSameDaytonaSandbox(session as DaytonaSandboxSession, persistedState);
}

// Saved between turns, so it carries no credentials. On Vercel this captures
// the snapshot the next turn resumes from.
export async function serializeSandboxSession(
  client: SandboxClient,
  session: SandboxSession,
  config: SandboxConfig,
  reportException: typeof reportWorkerException = reportWorkerException,
): Promise<Record<string, unknown>> {
  if (config.vercel) {
    try {
      await captureVercelSandboxSnapshot(session as VercelSandboxSession, config);
    } catch (error) {
      // The turn's result stands. Without a new snapshot the saved state does
      // not match the sandbox, so the next turn starts in a fresh one.
      const sandboxId = (session as VercelSandboxSession).state.sandboxId;
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "vercel_sandbox_snapshot_failed",
        sandboxId,
      }));
      await reportException(error, { operation: "sandbox_cleanup", sandboxId });
    }
  }
  const state = config.vercel
    ? await (client as VercelSandboxClient).serializeSessionState(
      (session as VercelSandboxSession).state,
    )
    : await (client as DaytonaClient).serializeSessionState(
      (session as DaytonaSandboxSession).state,
    );
  delete state.apiKey;
  delete state.networkPolicy;
  delete state.projectId;
  delete state.teamId;
  delete state.token;
  return state;
}

export async function closeSandbox(
  session: SandboxSession,
  config: SandboxConfig,
  context: Omit<WorkerErrorContext, "operation" | "sandboxId">,
): Promise<void> {
  await (config.vercel
    ? closeVercelSandbox(session as VercelSandboxSession, context)
    : closeDaytonaSandbox(session as DaytonaSandboxSession, config, context));
}
