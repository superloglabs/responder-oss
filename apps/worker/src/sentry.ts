import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeSentryConnection } from "@responder/core/db/investigations";

interface SentryMcpRequestContext {
  investigationId: string;
}

interface SentryMcpRequestDetails {
  mcpMethod?: string;
  method: string;
  toolName?: string;
}

class SentryMcpServer extends MCPServerStreamableHttp {
  constructor(
    options: ConstructorParameters<typeof MCPServerStreamableHttp>[0],
    private readonly context: SentryMcpRequestContext,
  ) {
    super(options);
  }

  override async callToolResult(
    ...args: Parameters<MCPServerStreamableHttp["callToolResult"]>
  ): ReturnType<MCPServerStreamableHttp["callToolResult"]> {
    const startedAt = performance.now();
    try {
      return await super.callToolResult(...args);
    } catch (error) {
      console.error(
        JSON.stringify({
          durationMs: Math.round(performance.now() - startedAt),
          errorCode: errorCode(error),
          errorName: errorName(error),
          event: "sentry_mcp_tool_call_failed",
          investigationId: this.context.investigationId,
          toolName: args[0].slice(0, 100),
        }),
      );
      throw error;
    }
  }
}

function requestDetails(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): SentryMcpRequestDetails {
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  if (method !== "POST" || typeof init?.body !== "string") return { method };

  try {
    const payload: unknown = JSON.parse(init.body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { method };
    }
    const record = payload as Record<string, unknown>;
    const params =
      record.params &&
      typeof record.params === "object" &&
      !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : null;
    return {
      method,
      ...(typeof record.method === "string"
        ? { mcpMethod: record.method.slice(0, 100) }
        : {}),
      ...(record.method === "tools/call" && typeof params?.name === "string"
        ? { toolName: params.name.slice(0, 100) }
        : {}),
    };
  } catch {
    return { method };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 100) : typeof error;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_-]{1,100}$/u.test(code)
    ? code
    : undefined;
}

function expectedUnsupportedRequest(
  details: SentryMcpRequestDetails,
  response: Response,
): boolean {
  return (
    response.status === 405 &&
    (details.method === "GET" || details.method === "DELETE")
  );
}

export function createSentryMcpFetch(
  context: SentryMcpRequestContext,
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  // The agent SDK redacts errors for every endpoint with a query string and
  // drops the original cause. Sentry intentionally uses `?skills=inspect`, so
  // record safe transport details before the SDK replaces the failure.
  return async (input, init) => {
    const startedAt = performance.now();
    const details = requestDetails(input, init);
    try {
      const response = await fetchImpl(input, init);
      if (!response.ok && !expectedUnsupportedRequest(details, response)) {
        console.error(
          JSON.stringify({
            ...details,
            durationMs: Math.round(performance.now() - startedAt),
            event: "sentry_mcp_http_error",
            investigationId: context.investigationId,
            retryAfter: response.headers.get("retry-after") ?? undefined,
            status: response.status,
            statusText: response.statusText.slice(0, 100) || undefined,
            upstreamRequestId:
              response.headers.get("x-request-id") ??
              response.headers.get("x-sentry-request-id") ??
              undefined,
          }),
        );
      }
      return response;
    } catch (error) {
      const cause =
        error && typeof error === "object"
          ? (error as { cause?: unknown }).cause
          : undefined;
      console.error(
        JSON.stringify({
          ...details,
          causeCode: errorCode(cause),
          causeName: cause === undefined ? undefined : errorName(cause),
          durationMs: Math.round(performance.now() - startedAt),
          errorCode: errorCode(error),
          errorName: errorName(error),
          event: "sentry_mcp_transport_error",
          investigationId: context.investigationId,
        }),
      );
      throw error;
    }
  };
}

export function sentryMcpHeaders(
  connection: RuntimeSentryConnection,
): Record<string, string> {
  return {
    authorization: `Sentry-Bearer ${connection.accessToken}`,
  };
}

export function createSentryMcpServer(
  connection: RuntimeSentryConnection,
  context: SentryMcpRequestContext,
): MCPServerStreamableHttp {
  return new SentryMcpServer(
    {
      cacheToolsList: true,
      clientSessionTimeoutSeconds: 300,
      fetch: createSentryMcpFetch(context),
      name: "sentry",
      requestInit: {
        headers: sentryMcpHeaders(connection),
      },
      timeout: 30_000,
      url: connection.mcpUrl,
      useStructuredContent: true,
    },
    context,
  );
}
