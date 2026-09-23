import {
  DaytonaSandboxClient,
  type DaytonaSandboxClientOptions,
  type DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import {
  daytonaClientOptions,
  type DaytonaClientConfig,
} from "@responder/core/daytona-config";
import { modelBrokerTokenEnvironmentVariable } from "./automation-harness.js";
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

export interface FreshAutomationSandboxInput<T> {
  brokerToken: string;
  config: DaytonaClientConfig;
  organizationId: string;
  signal?: AbortSignal;
  secrets?: DaytonaSandboxSecretMount[];
  run(
    session: DaytonaSandboxSession,
    withModelBroker: <Result>(operation: () => Promise<Result>) => Promise<Result>,
    signal: AbortSignal | undefined,
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
    pauseOnExit: false,
  });
  let session: DaytonaSandboxSession | null = null;
  let creationStarted = false;

  try {
    creationStarted = true;
    session = await abortable(
      dependencies.createSession(client, input.config, sandboxName),
      input.signal,
    );
    await abortable(
      dependencies.configure(session, input.config, input.secrets ?? []),
      input.signal,
    );
    if (!input.config.sandboxSnapshotName) {
      await abortable(dependencies.prepare(session), input.signal);
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
      const run = input.run(activeSession, modelBroker.run, input.signal);
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
    return outcome.value;
  } finally {
    if (session) {
      await dependencies.close(session, input.config, {
        jobId: input.runId,
        organizationId: input.organizationId,
      });
    } else if (creationStarted) {
      await dependencies.closePending(sandboxName, input.config);
    }
  }
}
