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
  prepareDaytonaSandbox,
} from "./sandbox.js";

interface AutomationSandboxDependencies {
  close: typeof closeDaytonaSandbox;
  configure: typeof configureDaytonaSandboxLifecycle;
  createClient(options: DaytonaSandboxClientOptions): DaytonaSandboxClient;
  createSession: typeof createDaytonaSandboxSession;
  prepare: typeof prepareDaytonaSandbox;
}

const defaultDependencies: AutomationSandboxDependencies = {
  close: closeDaytonaSandbox,
  configure: configureDaytonaSandboxLifecycle,
  createClient: (options) => new DaytonaSandboxClient(options),
  createSession: createDaytonaSandboxSession,
  prepare: prepareDaytonaSandbox,
};

export interface FreshAutomationSandboxInput<T> {
  brokerToken: string;
  config: DaytonaClientConfig;
  organizationId: string;
  run(
    session: DaytonaSandboxSession,
    withModelBroker: <Result>(operation: () => Promise<Result>) => Promise<Result>,
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

function serializedModelBrokerAccess(
  session: DaytonaSandboxSession,
  brokerToken: string,
): <Result>(operation: () => Promise<Result>) => Promise<Result> {
  let previous = Promise.resolve();
  return <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const current = previous.then(() =>
      withRunScopedModelBroker(session, brokerToken, operation)
    );
    previous = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
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

  try {
    session = await dependencies.createSession(
      client,
      input.config,
      sandboxName,
    );
    await dependencies.configure(session, input.config);
    if (!input.config.sandboxSnapshotName) {
      await dependencies.prepare(session);
    }
    const activeSession = session;
    return await input.run(
      activeSession,
      serializedModelBrokerAccess(activeSession, input.brokerToken),
    );
  } finally {
    if (session) {
      await dependencies.close(session, input.config, {
        jobId: input.runId,
        organizationId: input.organizationId,
      });
    }
  }
}
