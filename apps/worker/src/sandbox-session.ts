import { sandboxProvider } from "@responder/core/sandbox-config";
import type {
  DaytonaSandboxClient,
  DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import type {
  VercelSandboxClient,
  VercelSandboxSession,
} from "@openai/agents-extensions/sandbox/vercel";

export type SandboxClient = DaytonaSandboxClient | VercelSandboxClient;
export type SandboxSession = DaytonaSandboxSession | VercelSandboxSession;

// A worker uses one provider, so its sessions all come from it.
export function isVercelSandboxSession(
  session: SandboxSession,
): session is VercelSandboxSession {
  void session;
  return sandboxProvider() === "vercel";
}

export interface SandboxSecretMount {
  allowedHosts?: string[];
  daytonaSecretName: string | null;
  encryptedValue?: string | null;
  environmentVariable: string;
  // Set for a secret the worker already holds, such as a run's access token.
  placeholder?: string;
  value?: string;
}
