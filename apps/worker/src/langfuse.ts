import {
  MCPServerStreamableHttp,
  type CallToolResultContent,
  type MCPCallToolOptions,
  type MCPServer,
} from "@openai/agents";
import type { RuntimeLangfuseConnection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import {
  langfuseBasicAuthorization,
  langfuseMcpUrl,
} from "@responder/core/integrations/langfuse";

export const LANGFUSE_CONTEXT_MCP_TOOLS = [
  "getAlert",
  "getMetricsSchema",
  "getObservation",
  "getObservationFieldSchema",
  "getObservationFilterSchema",
  "getObservationFilterValues",
  "getPrompt",
  "getPromptUnresolved",
  "getScore",
  "listAlerts",
  "listObservations",
  "listPrompts",
  "listScores",
  "queryMetrics",
] as const;

const LANGFUSE_CONTEXT_MCP_TOOL_SET = new Set<string>(
  LANGFUSE_CONTEXT_MCP_TOOLS,
);
const SENSITIVE_KEY =
  /api.?key|authorization|credential|password|private.?key|secret|session|signature|token/i;
const REDACTED = "[redacted]";
const MAX_OUTPUT_LENGTH = 100_000;
const MAX_LANGFUSE_CONCURRENCY = 2;
const DEFAULT_OBSERVATION_WINDOW_MS = 24 * 60 * 60 * 1_000;

let activeLangfuseOperations = 0;
const pendingLangfuseOperations: Array<() => void> = [];

async function withLangfuseConcurrencyLimit<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (activeLangfuseOperations >= MAX_LANGFUSE_CONCURRENCY) {
    await new Promise<void>((resolve) => pendingLangfuseOperations.push(resolve));
  } else {
    activeLangfuseOperations += 1;
  }
  try {
    return await operation();
  } finally {
    const nextOperation = pendingLangfuseOperations.shift();
    if (nextOperation) nextOperation();
    else activeLangfuseOperations -= 1;
  }
}

function sanitizedString(value: string, secrets: readonly string[]): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret.length >= 8) sanitized = sanitized.replaceAll(secret, REDACTED);
  }
  return sanitized.length > MAX_OUTPUT_LENGTH
    ? `${sanitized.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`
    : sanitized;
}

export function sanitizeLangfuseOutput(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (typeof value === "string") return sanitizedString(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLangfuseOutput(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key)
          ? REDACTED
          : sanitizeLangfuseOutput(item, secrets),
      ]),
    );
  }
  return value;
}

function boundedRecord(
  value: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  const sanitized = sanitizeLangfuseOutput(value, secrets) as Record<
    string,
    unknown
  >;
  const encoded = JSON.stringify(sanitized);
  return encoded.length > MAX_OUTPUT_LENGTH
    ? {
        output: `${encoded.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`,
        truncated: true,
      }
    : sanitized;
}

function sanitizeMcpResult(
  result: CallToolResultContent,
  secrets: readonly string[],
): CallToolResultContent {
  const sanitizedItems = result.map((item) =>
    sanitizeLangfuseOutput(item, secrets),
  ) as CallToolResultContent;
  const encodedItems = JSON.stringify(sanitizedItems);
  const content = (encodedItems.length > MAX_OUTPUT_LENGTH
    ? [
        {
          type: "text",
          text: `${encodedItems.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`,
        },
      ]
    : sanitizedItems) as CallToolResultContent;
  if (result._meta) content._meta = boundedRecord(result._meta, secrets);
  if (result.structuredContent) {
    content.structuredContent = boundedRecord(result.structuredContent, secrets);
  }
  if (result.isError !== undefined) content.isError = result.isError;
  return content;
}

function boundedLimit(value: unknown, maximum: number): number {
  if (value === undefined) return Math.min(50, maximum);
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error(`Langfuse list requests are limited to ${maximum} items`);
  }
  return value;
}

export function normalizedLangfuseArgs(
  toolName: string,
  args: Record<string, unknown> | null,
  now = new Date(),
): Record<string, unknown> | null {
  const normalized = { ...(args ?? {}) };
  if (toolName === "listObservations") {
    normalized.limit = boundedLimit(normalized.limit, 50);
    if (!normalized.traceId && !normalized.fromStartTime && !normalized.toStartTime) {
      normalized.fromStartTime = new Date(
        now.getTime() - DEFAULT_OBSERVATION_WINDOW_MS,
      ).toISOString();
      normalized.toStartTime = now.toISOString();
    }
  }
  if (["listAlerts", "listPrompts", "listScores"].includes(toolName)) {
    normalized.limit = boundedLimit(normalized.limit, 50);
  }
  if (toolName === "queryMetrics") {
    const config =
      normalized.config && typeof normalized.config === "object"
        ? { ...(normalized.config as Record<string, unknown>) }
        : {};
    config.row_limit = boundedLimit(config.row_limit, 100);
    normalized.config = config;
  }
  return normalized;
}

export class ScopedLangfuseMcpServer implements MCPServer {
  readonly cacheToolsList = true;
  readonly name: string;
  readonly useStructuredContent = true;

  constructor(
    private readonly server: MCPServer,
    private readonly connection: RuntimeLangfuseConnection,
  ) {
    this.name = `langfuse-${connection.accountId}`;
  }

  connect(): Promise<void> {
    return this.server.connect();
  }

  close(): Promise<void> {
    return this.server.close();
  }

  async listTools(): ReturnType<MCPServer["listTools"]> {
    const tools = await this.server.listTools();
    return tools.filter((tool) => LANGFUSE_CONTEXT_MCP_TOOL_SET.has(tool.name));
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResultContent> {
    if (!LANGFUSE_CONTEXT_MCP_TOOL_SET.has(toolName)) {
      throw new Error(`Langfuse tool ${toolName} is not available during investigations`);
    }
    const normalizedArgs = normalizedLangfuseArgs(toolName, args);
    const secrets = [this.connection.publicKey, this.connection.secretKey];
    try {
      const result = await withLangfuseConcurrencyLimit(() =>
        this.server.callTool(toolName, normalizedArgs, meta, options),
      );
      return sanitizeMcpResult(result, secrets);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(sanitizedString(message, secrets));
    }
  }

  invalidateToolsCache(): Promise<void> {
    return this.server.invalidateToolsCache();
  }
}

export function langfuseMcpHeaders(
  connection: RuntimeLangfuseConnection,
): Record<string, string> {
  return {
    authorization: langfuseBasicAuthorization(connection),
  };
}

export function createLangfuseMcpServer(
  connection: RuntimeLangfuseConnection,
): MCPServer {
  const server = new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: `langfuse-upstream-${connection.accountId}`,
    requestInit: {
      headers: langfuseMcpHeaders(connection),
    },
    timeout: 30_000,
    toolFilter: {
      allowedToolNames: [...LANGFUSE_CONTEXT_MCP_TOOLS],
    },
    url: langfuseMcpUrl(connection.baseUrl),
    useStructuredContent: true,
  });
  return new ScopedLangfuseMcpServer(server, connection);
}
