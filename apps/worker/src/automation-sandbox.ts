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
  run(session: DaytonaSandboxSession): Promise<T>;
  runId: string;
}

function sandboxNameForRun(runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/u.test(runId)) {
    throw new Error("Automation run ID cannot be used as a sandbox name");
  }
  return `responder-automation-${runId}`;
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
    env: {
      [modelBrokerTokenEnvironmentVariable]: input.brokerToken,
    },
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
    return await input.run(session);
  } finally {
    if (session) {
      await dependencies.close(session, input.config, {
        jobId: input.runId,
        organizationId: input.organizationId,
      });
    }
  }
}
