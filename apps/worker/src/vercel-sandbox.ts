import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { Manifest } from "@openai/agents/sandbox";
import {
  VercelSandboxClient,
  VercelSandboxSession,
  type VercelSandboxSessionState,
} from "@openai/agents-extensions/sandbox/vercel";
import { daytonaSecretPlaceholderPrefix } from "@responder/core/automations/chatgpt-subscription";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import { sandboxWorkspaceRoot, type VercelSandboxConfig } from "@responder/core/sandbox-config";
import { sandboxAllowedDomains, type SandboxNetwork } from "@responder/core/sandbox-network";
import { Sandbox, type Command, type CommandFinished } from "@vercel/sandbox";
import { reportWorkerException, type WorkerErrorContext } from "./monitoring.js";
import { sandboxSnapshotResources } from "./sandbox-snapshot.js";
import type { SandboxSecretMount } from "./sandbox-session.js";

type VercelSandboxSessionArguments = ConstructorParameters<typeof VercelSandboxSession>[0];
type NetworkPolicy = Parameters<Sandbox["updateNetworkPolicy"]>[0];
type VercelCommandParams = Parameters<Sandbox["runCommand"]>[0];
type NetworkPolicyRule = Exclude<
  Exclude<NetworkPolicy, string>["allow"],
  string[] | undefined
>[string][number];

// Longer than the longest run. Vercel stops a sandbox the worker lost.
const vercelSandboxTimeoutMs = 2 * 60 * 60 * 1_000;
// Matches how long Daytona keeps a paused sandbox.
const pausedSnapshotLifetimeMs = 24 * 60 * 60 * 1_000;
const vercelCreateAttempts = 3;
const vercelCreateRetryDelayMs = 5_000;
const uploadChunkBytes = 32 * 1024 * 1024;
// Enough waits to outlast the sandbox even when each one drops early. Vercel
// sends no response until the command ends, so each wait for a command that
// runs longer than five minutes ends with a headers timeout.
const commandWaitAttempts = 50;
const commandWaitRetryDelayMs = 2_000;

// The firewall can only match a whole header, so each place a credential
// usually goes needs its own rule. A placeholder anywhere else reaches the
// host unchanged and the request is rejected.
const authorizationSchemes = ["", "Bearer ", "Bot ", "Token ", "bearer ", "token "];
const credentialHeaders = [
  "api-key",
  "dd-api-key",
  "dd-application-key",
  "private-token",
  "x-api-key",
  "x-api-token",
  "x-auth-token",
  "x-goog-api-key",
  "x-token",
];

export function createVercelSandboxClient(
  config: VercelSandboxConfig,
  options: { pauseOnExit: boolean },
): VercelSandboxClient {
  return new VercelSandboxClient({
    ...config.vercel,
    // Capturing a snapshot on close only helps a sandbox that is resumed.
    workspacePersistence: options.pauseOnExit ? "snapshot" : "tar",
  });
}

function isRetryableVercelError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "response" in error
    ? (error.response as { status?: unknown } | undefined)?.status
    : undefined;
  return typeof status !== "number" || status === 429 || status >= 500;
}

const droppedConnectionCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// A wait that ended without the command's result: the stream ended early,
// the connection closed, or Vercel answered with a server error.
function isDroppedVercelWait(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "StreamError") return true;
  if ("response" in error) return isRetryableVercelError(error);
  const cause = error.cause as { code?: unknown } | undefined;
  return error.message === "terminated" ||
    error.message === "fetch failed" ||
    droppedConnectionCodes.has(String((error as { code?: unknown }).code)) ||
    droppedConnectionCodes.has(String(cause?.code));
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code ??
    ((error as { cause?: { code?: unknown } } | undefined)?.cause)?.code;
  return typeof code === "string" ? code : undefined;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

// A waited command streams its result over the request that started it. When
// the command runs for minutes without output, that stream can end without
// the result. So the command runs detached, the worker waits on it with a
// separate request, and a wait that drops is started again.
export async function runVercelCommand(
  sandbox: Pick<Sandbox, "runCommand">,
  params: VercelCommandParams,
  sleep: (delayMs: number) => Promise<void> = defaultSleep,
): Promise<CommandFinished> {
  const command = await sandbox.runCommand({ ...params, detached: true }) as Command;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await command.wait(params.signal ? { signal: params.signal } : undefined);
    } catch (error) {
      if (
        attempt >= commandWaitAttempts ||
        params.signal?.aborted ||
        !isDroppedVercelWait(error)
      ) {
        throw error;
      }
      // Expected for long commands. A wait that cannot recover throws above.
      console.warn(JSON.stringify({
        attempt,
        cmdId: command.cmdId,
        error: error instanceof Error ? error.message : String(error),
        errorCode: errorCode(error),
        event: "vercel_command_wait_retry",
      }));
      await sleep(commandWaitRetryDelayMs);
    }
  }
}

// The SDK session runs every command as one waited request. This sends its
// commands through runVercelCommand instead.
function reattachCommands(sandbox: Sandbox): void {
  const runCommand = sandbox.runCommand.bind(sandbox);
  const start = { runCommand } as Pick<Sandbox, "runCommand">;
  Object.defineProperty(sandbox, "runCommand", {
    value: (
      commandOrParams: string | VercelCommandParams,
      args?: string[],
      options?: { signal?: AbortSignal; timeoutMs?: number },
    ) => {
      const params: VercelCommandParams = typeof commandOrParams === "string"
        ? { args, cmd: commandOrParams, signal: options?.signal, timeoutMs: options?.timeoutMs }
        : commandOrParams;
      return params.detached ? runCommand(params) : runVercelCommand(start, params);
    },
  });
}

// Starts the sandbox here rather than through the SDK client, which cannot
// choose a region or a starting snapshot. The session runs on what it returns.
async function startVercelSession(
  config: VercelSandboxConfig,
  state: VercelSandboxSessionState,
  snapshotId: string,
): Promise<VercelSandboxSession> {
  const sandbox = await Sandbox.create({
    ...config.vercel,
    persistent: false,
    region: config.region,
    resources: { vcpus: config.vcpus ?? sandboxSnapshotResources.cpu },
    source: { snapshotId, type: "snapshot" },
    timeout: vercelSandboxTimeoutMs,
  });
  try {
    // The SDK client was written for the older sandbox shape.
    Object.defineProperty(sandbox, "sandboxId", { value: sandbox.name });
    reattachCommands(sandbox);
    const session = new VercelSandboxSession({
      credentials: config.vercel,
      sandbox: sandbox as unknown as VercelSandboxSessionArguments["sandbox"],
      state: {
        ...state,
        ...config.vercel,
        authenticationMode: "explicit",
        sandboxId: sandbox.name,
        snapshotExpirationMs: pausedSnapshotLifetimeMs,
        snapshotId,
        snapshotSandboxId: undefined,
        snapshotSupported: true,
        timeoutMs: vercelSandboxTimeoutMs,
      },
    });
    await session.prepareWorkspaceRoot();
    return session;
  } catch (error) {
    await sandbox.stop().catch(() => undefined);
    throw error;
  }
}

export async function createVercelSandboxSession(
  config: VercelSandboxConfig,
  persistence: VercelSandboxSessionState["workspacePersistence"],
  signal?: AbortSignal,
  sleep: (delayMs: number) => Promise<void> = defaultSleep,
): Promise<VercelSandboxSession> {
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const session = await startVercelSession(config, {
        environment: {},
        manifest: new Manifest({ root: sandboxWorkspaceRoot }),
        sandboxId: "",
        workspacePersistence: persistence,
      }, config.sandboxSnapshotName);
      if (signal?.aborted) {
        await session.close().catch(() => undefined);
        signal.throwIfAborted();
      }
      return session;
    } catch (error) {
      if (attempt >= vercelCreateAttempts || signal?.aborted || !isRetryableVercelError(error)) {
        throw error;
      }
      console.error(JSON.stringify({
        attempt,
        errorName: error instanceof Error ? error.name : typeof error,
        event: "vercel_sandbox_create_retry",
      }));
      await sleep(vercelCreateRetryDelayMs);
    }
  }
}

export function vercelSecretPlaceholder(): string {
  // Daytona's format, so redaction and the subscription checks cover both.
  return `${daytonaSecretPlaceholderPrefix}${randomBytes(24).toString("hex")}`;
}

function secretValue(secret: SandboxSecretMount): string {
  if (secret.value) return secret.value;
  if (!secret.encryptedValue) {
    throw new Error(
      `Workspace secret ${secret.environmentVariable} must be saved again before it can be used`,
    );
  }
  return decryptCredentials<{ value: string }>(secret.encryptedValue).value;
}

function secretRules(placeholder: string, value: string): NetworkPolicyRule[] {
  const rule = (header: string, sent: string, replacement: string) => ({
    match: { headers: [{ key: { exact: header }, value: { exact: sent } }] },
    transform: [{ headers: { [header]: replacement } }],
  }) as NetworkPolicyRule;
  return [
    ...authorizationSchemes.map((scheme) =>
      rule("authorization", `${scheme}${placeholder}`, `${scheme}${value}`)
    ),
    ...credentialHeaders.map((header) => rule(header, placeholder, value)),
  ];
}

// Each sandbox sees only placeholders, and the firewall swaps a placeholder
// for its value on requests to the secret's allowed hosts. Outbound access is
// limited to the workspace's list of domains, or open when the workspace has
// turned the restriction off. Real values
// stay out of the session state, which is saved to the database, so this is
// applied after every start.
export function secretNetworkPolicy(
  secrets: ReadonlyArray<{ allowedHosts: string[]; placeholder: string; value: string }>,
  network: SandboxNetwork | null = null,
): NetworkPolicy {
  const allow: Record<string, NetworkPolicyRule[]> = {};
  if (network) {
    for (const domain of sandboxAllowedDomains(network, secrets)) {
      allow[domain] = [];
      // Vercel's `*.example.com` leaves out example.com itself, which
      // Daytona's includes.
      if (domain.startsWith("*.")) allow[domain.slice(2)] = [];
    }
  } else {
    allow["*"] = [];
  }
  for (const secret of secrets) {
    for (const host of secret.allowedHosts) {
      const rules = secretRules(secret.placeholder, secret.value);
      (allow[host] ??= []).push(...rules);
      if (host.startsWith("*.")) (allow[host.slice(2)] ??= []).push(...rules);
    }
  }
  return { allow } as NetworkPolicy;
}

export async function applyVercelSandboxSecrets(
  session: VercelSandboxSession,
  config: VercelSandboxConfig,
  secrets: SandboxSecretMount[],
  network: SandboxNetwork | null = null,
): Promise<void> {
  const environment = session.state.environment;
  const mounted = Object.entries(environment)
    .filter(([, value]) => value.startsWith(daytonaSecretPlaceholderPrefix));
  if (secrets.length === 0 && mounted.length === 0 && !network) return;

  const placeholders = secrets.map((secret) => ({
    allowedHosts: secret.allowedHosts ?? [],
    environmentVariable: secret.environmentVariable,
    placeholder: secret.placeholder ?? vercelSecretPlaceholder(),
    value: secretValue(secret),
  }));
  const sandbox = await Sandbox.get({ ...config.vercel, name: session.state.sandboxId });
  await sandbox.updateNetworkPolicy(secretNetworkPolicy(placeholders, network));
  for (const [name] of mounted) delete environment[name];
  for (const secret of placeholders) {
    environment[secret.environmentVariable] = secret.placeholder;
  }
}

// Captures the snapshot the next turn resumes from, which also stops the
// sandbox. Closing the session afterwards does not capture another.
export async function captureVercelSandboxSnapshot(
  session: VercelSandboxSession,
  config: VercelSandboxConfig,
): Promise<void> {
  const sandbox = await Sandbox.get({ ...config.vercel, name: session.state.sandboxId });
  const snapshot = await sandbox.snapshot({ expiration: pausedSnapshotLifetimeMs });
  session.state.snapshotId = snapshot.snapshotId;
  session.state.snapshotSandboxId = session.state.sandboxId;
}

export async function resumeVercelSandbox(
  client: VercelSandboxClient,
  persistedState: Record<string, unknown>,
  config: VercelSandboxConfig,
): Promise<VercelSandboxSession> {
  const state = await client.deserializeSessionState(persistedState);
  if (!resumedSameVercelSandbox(persistedState) || !state.snapshotId) {
    throw new Error("The paused sandbox has no snapshot");
  }
  return startVercelSession(config, state, state.snapshotId);
}

// A sandbox resumes from the snapshot its pause captured, under a new ID.
export function resumedSameVercelSandbox(persistedState: Record<string, unknown>): boolean {
  return Boolean(persistedState.snapshotId) &&
    persistedState.snapshotSandboxId === persistedState.sandboxId;
}

export async function closeVercelSandbox(
  session: VercelSandboxSession,
  context: Omit<WorkerErrorContext, "operation" | "sandboxId">,
  reportException: typeof reportWorkerException = reportWorkerException,
): Promise<void> {
  const sandboxId = session.state.sandboxId;
  try {
    await session.close();
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      event: "vercel_sandbox_cleanup_failed",
      sandboxId,
      ...context,
    }));
    await reportException(error, { operation: "sandbox_cleanup", sandboxId, ...context });
  }
}

function sandboxForSession(session: VercelSandboxSession): Promise<Sandbox> {
  const { projectId, sandboxId, teamId, token } = session.state;
  if (!projectId || !teamId || !token) {
    throw new Error("Vercel credentials are unavailable for file transfer");
  }
  return Sandbox.get({ name: sandboxId, projectId, teamId, token });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runChecked(sandbox: Sandbox, command: string): Promise<void> {
  const result = await runVercelCommand(sandbox, { args: ["-c", command], cmd: "/bin/sh" });
  if (result.exitCode !== 0) throw new Error("Unable to write a file to the Vercel sandbox");
}

// Written in parts, because Vercel's file API holds each write in memory and
// a repository archive can reach several gigabytes.
export async function uploadVercelSandboxFile(
  session: VercelSandboxSession,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const sandbox = await sandboxForSession(session);
  const partPath = `${remotePath}.part`;
  const quotedPath = shellQuote(remotePath);
  const quotedPart = shellQuote(partPath);
  await runChecked(sandbox, `mkdir -p "$(dirname ${quotedPath})" && : > ${quotedPath}`);
  for await (const chunk of createReadStream(localPath, { highWaterMark: uploadChunkBytes })) {
    await sandbox.writeFiles([{ content: chunk as Buffer, path: partPath }]);
    await runChecked(sandbox, `cat ${quotedPart} >> ${quotedPath} && rm -f ${quotedPart}`);
  }
}

export async function downloadVercelSandboxFile(
  session: VercelSandboxSession,
  remotePath: string,
): Promise<Uint8Array> {
  const sandbox = await sandboxForSession(session);
  const content = await sandbox.readFileToBuffer({ path: remotePath });
  if (!content) throw new Error(`Sandbox path not found: ${remotePath}`);
  return Uint8Array.from(content);
}
