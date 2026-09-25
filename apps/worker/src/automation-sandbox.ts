import {
  DaytonaSandboxClient,
  type DaytonaSandboxClientOptions,
  type DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import {
  daytonaClientOptions,
  type DaytonaClientConfig,
} from "@responder/core/daytona-config";
import {
  automationWorkspaceRoot,
  modelBrokerTokenEnvironmentVariable,
} from "./automation-harness.js";
import {
  closeDaytonaSandbox,
  configureDaytonaSandboxLifecycle,
  createDaytonaSandboxSession,
  deleteDaytonaSandboxByName,
  prepareDaytonaSandbox,
  type DaytonaSandboxSecretMount,
} from "./sandbox.js";

interface AutomationSandboxDependencies {
  close: typeof closeDaytonaSandbox;
  closePending: typeof deleteDaytonaSandboxByName;
  configure: typeof configureDaytonaSandboxLifecycle;
  createClient(options: DaytonaSandboxClientOptions): DaytonaSandboxClient;
  createSession: typeof createDaytonaSandboxSession;
  prepare: typeof prepareDaytonaSandbox;
}

const defaultDependencies: AutomationSandboxDependencies = {
  close: closeDaytonaSandbox,
  closePending: deleteDaytonaSandboxByName,
  configure: configureDaytonaSandboxLifecycle,
  createClient: (options) => new DaytonaSandboxClient(options),
  createSession: createDaytonaSandboxSession,
  prepare: prepareDaytonaSandbox,
};

// Written once a sandbox has its tools and repositories. A resumed sandbox
// without it is set up again.
export const automationSandboxReadyMarker =
  `${automationWorkspaceRoot}/.responder/automation-sandbox-ready`;

// A paused sandbox is deleted by Daytona this long after it stops.
export const pausedAutomationSandboxLifetimeMinutes = 24 * 60;

export interface PausedAutomationSandbox {
  id: string;
  sessionState: Record<string, unknown>;
}

export interface FreshAutomationSandboxInput<T> {
  brokerToken: string;
  onCleanupConfirmed?: () => void;
  config: DaytonaClientConfig;
  // Pause the sandbox after the run so a follow-up can resume it.
  keepPaused?: boolean;
  onPaused?: (sandbox: PausedAutomationSandbox) => void;
  organizationId: string;
  // A paused sandbox from an earlier turn of the run.
  resumeState?: Record<string, unknown>;
  signal?: AbortSignal;
  secrets?: DaytonaSandboxSecretMount[];
  run(
    session: DaytonaSandboxSession,
    withModelBroker: <Result>(operation: () => Promise<Result>) => Promise<Result>,
    signal: AbortSignal | undefined,
    resumed: boolean,
  ): Promise<T>;
  runId: string;
}

function sandboxNameForRun(runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/u.test(runId)) {
    throw new Error("Automation run ID cannot be used as a sandbox name");
  }
  const sandboxName = `responder-automation-${runId}`;
  if (sandboxName.length > 64) {
    throw new Error("Automation run ID cannot be used as a sandbox name");
  }
  return sandboxName;
}

async function withRunScopedModelBroker<Result>(
  session: DaytonaSandboxSession,
  brokerToken: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  // This token is an intentionally untrusted, least-privilege capability for
  // the harness process, not a customer provider credential. The broker must
  // bind it to one run, model, budget, and short expiry. Limit its lifetime in
  // the sandbox environment to the model operation so setup commands never
  // receive it.
  const environment = session.state.environment;
  const previousValue = environment[modelBrokerTokenEnvironmentVariable];
  environment[modelBrokerTokenEnvironmentVariable] = brokerToken;
  try {
    return await operation();
  } finally {
    if (previousValue === undefined) {
      delete environment[modelBrokerTokenEnvironmentVariable];
    } else {
      environment[modelBrokerTokenEnvironmentVariable] = previousValue;
    }
  }
}

interface SerializedModelBrokerAccess {
  drain(): Promise<void>;
  run<Result>(operation: () => Promise<Result>): Promise<Result>;
}

const modelBrokerDrainTimeoutMs = 30_000;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Automation sandbox operation was aborted");
}

async function abortable<Result>(
  operation: Promise<Result>,
  signal: AbortSignal | undefined,
): Promise<Result> {
  if (!signal) return operation;
  if (signal.aborted) throw abortReason(signal);
  let rejectFromAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectFromAbort = reject;
  });
  const onAbort = () => rejectFromAbort?.(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function serializedModelBrokerAccess(
  session: DaytonaSandboxSession,
  brokerToken: string,
): SerializedModelBrokerAccess {
  let previous = Promise.resolve();
  let acceptingOperations = true;
  let queuedFailure: unknown;
  let queuedOperationFailed = false;

  return {
    async drain(): Promise<void> {
      acceptingOperations = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          previous,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              delete session.state.environment[
                modelBrokerTokenEnvironmentVariable
              ];
              reject(new Error("Model broker drain timed out"));
            }, modelBrokerDrainTimeoutMs);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (queuedOperationFailed) throw queuedFailure;
    },
    run<Result>(operation: () => Promise<Result>): Promise<Result> {
      if (!acceptingOperations) {
        return Promise.reject(new Error("Model broker operation queue is closed"));
      }
      const current = previous.then(() =>
        withRunScopedModelBroker(session, brokerToken, operation)
      );
      previous = current.then(
        () => undefined,
        (error: unknown) => {
          if (!queuedOperationFailed) {
            queuedOperationFailed = true;
            queuedFailure = error;
          }
        },
      );
      return current;
    },
  };
}

// Stops the sandbox and reports its state for the next turn. Returns false
// when it could not be paused, so the caller deletes it instead.
async function pauseSandbox(
  client: DaytonaSandboxClient,
  session: DaytonaSandboxSession,
  input: Pick<FreshAutomationSandboxInput<unknown>, "onPaused" | "runId">,
): Promise<boolean> {
  try {
    const sessionState = await client.serializeSessionState(session.state);
    delete sessionState.apiKey;
    const environment = sessionState.environment;
    if (typeof environment === "object" && environment !== null) {
      delete (environment as Record<string, unknown>)[modelBrokerTokenEnvironmentVariable];
    }
    await session.close();
    input.onPaused?.({ id: session.state.sandboxId, sessionState });
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: error instanceof Error ? error.name : typeof error,
      event: "automation_sandbox_pause_failed",
      runId: input.runId,
    }));
    return false;
  }
}

export async function runInFreshAutomationSandbox<T>(
  input: FreshAutomationSandboxInput<T>,
  dependencies: AutomationSandboxDependencies = defaultDependencies,
): Promise<T> {
  if (!input.brokerToken) {
    throw new Error("A short-lived model broker token is required");
  }
  const sandboxName = sandboxNameForRun(input.runId);
  const client = dependencies.createClient({
    ...daytonaClientOptions(input.config),
    name: sandboxName,
    pauseOnExit: Boolean(input.keepPaused),
  });
  let session: DaytonaSandboxSession | null = null;
  let creationStarted = false;
  let resumed = false;
  let executionOutcome:
    | { error: unknown; succeeded: false }
    | { succeeded: true; value: T };

  try {
    creationStarted = true;
    if (input.resumeState) {
      try {
        session = await abortable(
          client.resume(await client.deserializeSessionState(input.resumeState)),
          input.signal,
        );
        // Daytona recreates a sandbox it no longer has; that one needs setup.
        resumed = await session.pathExists(automationSandboxReadyMarker);
      } catch (error) {
        input.signal?.throwIfAborted();
        console.error(JSON.stringify({
          errorCode: error instanceof Error ? error.name : typeof error,
          event: "automation_sandbox_resume_failed",
          runId: input.runId,
        }));
        session = null;
      }
    }
    session ??= await abortable(
      dependencies.createSession(client, input.config, sandboxName),
      input.signal,
    );
    if (!resumed) {
      await abortable(
        dependencies.configure(
          session,
          input.config,
          input.secrets ?? [],
          input.keepPaused ? pausedAutomationSandboxLifetimeMinutes : 0,
        ),
        input.signal,
      );
      if (!input.config.sandboxSnapshotName) {
        await abortable(dependencies.prepare(session), input.signal);
      }
    }
    const activeSession = session;
    const modelBroker = serializedModelBrokerAccess(
      activeSession,
      input.brokerToken,
    );
    let outcome:
      | { error: unknown; succeeded: false }
      | { succeeded: true; value: T };
    try {
      const run = input.run(activeSession, modelBroker.run, input.signal, resumed);
      const value = await abortable(run, input.signal);
      outcome = { succeeded: true, value };
    } catch (error) {
      outcome = { error, succeeded: false };
    }
    try {
      await modelBroker.drain();
    } catch (queueError) {
      if (outcome.succeeded) throw queueError;
      if (queueError === outcome.error) throw outcome.error;
      throw new AggregateError(
        [outcome.error, queueError],
        "Automation callback and queued model operation failed",
      );
    }
    if (!outcome.succeeded) throw outcome.error;
    executionOutcome = { succeeded: true, value: outcome.value };
  } catch (error) {
    executionOutcome = { error, succeeded: false };
  }

  if (session && input.keepPaused && await pauseSandbox(client, session, input)) {
    if (!executionOutcome.succeeded) throw executionOutcome.error;
    return executionOutcome.value;
  }

  let cleanupFailure: unknown;
  try {
    if (session) {
      await dependencies.close(session, input.config, {
        jobId: input.runId,
        organizationId: input.organizationId,
      });
    } else if (creationStarted) {
      await dependencies.closePending(sandboxName, input.config);
    }
  } catch (error) {
    cleanupFailure = error;
  }

  if (cleanupFailure === undefined) input.onCleanupConfirmed?.();
  if (!executionOutcome.succeeded) {
    if (cleanupFailure !== undefined) {
      console.error(JSON.stringify({
        cleanupError:
          cleanupFailure instanceof Error
            ? cleanupFailure.constructor.name
            : "unknown",
        event: "automation_pending_sandbox_cleanup_failed",
        primaryError:
          executionOutcome.error instanceof Error
            ? executionOutcome.error.constructor.name
            : "unknown",
        runId: input.runId,
      }));
    }
    throw executionOutcome.error;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return executionOutcome.value;
}
