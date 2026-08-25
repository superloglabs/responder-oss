import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeSentryConnection } from "@responder/core/db/investigations";
import { AsyncLocalStorage } from "node:async_hooks";

interface SentryMcpRequestContext {
  investigationId: string;
}

interface SentryMcpRequestDetails {
  mcpMethod?: string;
  method: string;
  toolName?: string;
}

type SentryMcpTransportDiagnostics = Pick<
  SentryMcpRequestDetails,
  "mcpMethod" | "method" | "toolName"
> &
  (
    | {
        durationMs: number;
        kind: "http";
        retryAfter?: string;
        status: number;
        statusText?: string;
        upstreamRequestId?: string;
      }
    | {
        causeCode?: string;
        causeName?: string;
        durationMs: number;
        errorCode?: string;
        errorName: string;
        kind: "network";
      }
  );

interface SentryMcpToolCallState {
  transportFailureCount: number;
  transportFailures: Array<Omit<SentryMcpTransportDiagnostics, "toolName">>;
}

const MAX_TRANSPORT_FAILURES_PER_TOOL_CALL = 5;

function transportFailureFields(state: SentryMcpToolCallState): object {
  return state.transportFailureCount === 0
    ? {}
    : {
        transportFailureCount: state.transportFailureCount,
        transportFailures: state.transportFailures,
        transportFailuresTruncated:
          state.transportFailureCount > state.transportFailures.length ||
          undefined,
      };
}

class SentryMcpServer extends MCPServerStreamableHttp {
  constructor(
    options: ConstructorParameters<typeof MCPServerStreamableHttp>[0],
    private readonly context: SentryMcpRequestContext,
    private readonly toolCallStorage: AsyncLocalStorage<SentryMcpToolCallState>,
  ) {
    super(options);
  }

  override async callToolResult(
    ...args: Parameters<MCPServerStreamableHttp["callToolResult"]>
  ): ReturnType<MCPServerStreamableHttp["callToolResult"]> {
    const startedAt = performance.now();
    const state: SentryMcpToolCallState = {
      transportFailureCount: 0,
      transportFailures: [],
    };
    try {
      const result = await this.toolCallStorage.run(state, () =>
        super.callToolResult(...args),
      );
      if (state.transportFailureCount > 0) {
        console.info(
          JSON.stringify({
            durationMs: Math.round(performance.now() - startedAt),
            event: "sentry_mcp_tool_call_recovered",
            investigationId: this.context.investigationId,
            toolName: args[0].slice(0, 100),
            ...transportFailureFields(state),
          }),
        );
      }
      return result;
    } catch (error) {
      console.error(
        JSON.stringify({
          durationMs: Math.round(performance.now() - startedAt),
          errorCode: errorCode(error),
          errorName: errorName(error),
          event: "sentry_mcp_tool_call_failed",
          investigationId: this.context.investigationId,
          toolName: args[0].slice(0, 100),
          ...transportFailureFields(state),
        }),
      );
      throw error;
    }
  }
}

function recordTransportFailure(
  context: SentryMcpRequestContext,
  toolCallStorage: AsyncLocalStorage<SentryMcpToolCallState> | undefined,
  event: "sentry_mcp_http_error" | "sentry_mcp_transport_error",
  diagnostics: SentryMcpTransportDiagnostics,
): void {
  const state = toolCallStorage?.getStore();
  if (state) {
    const transport = { ...diagnostics };
    delete transport.toolName;
    state.transportFailureCount += 1;
    if (
      state.transportFailures.length < MAX_TRANSPORT_FAILURES_PER_TOOL_CALL
    ) {
      state.transportFailures.push(transport);
    }
    return;
  }
  console.error(
    JSON.stringify({
      ...diagnostics,
      event,
      investigationId: context.investigationId,
    }),
  );
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
  toolCallStorage?: AsyncLocalStorage<SentryMcpToolCallState>,
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
        recordTransportFailure(
          context,
          toolCallStorage,
          "sentry_mcp_http_error",
          {
            durationMs: Math.round(performance.now() - startedAt),
            kind: "http",
            mcpMethod: details.mcpMethod,
            method: details.method,
            retryAfter: response.headers.get("retry-after") ?? undefined,
            status: response.status,
            statusText: response.statusText.slice(0, 100) || undefined,
            toolName: details.toolName,
            upstreamRequestId:
              response.headers.get("x-request-id") ??
              response.headers.get("x-sentry-request-id") ??
              undefined,
          },
        );
      }
      return response;
    } catch (error) {
      const cause =
        error && typeof error === "object"
          ? (error as { cause?: unknown }).cause
          : undefined;
      recordTransportFailure(
        context,
        toolCallStorage,
        "sentry_mcp_transport_error",
        {
          causeCode: errorCode(cause),
          causeName: cause === undefined ? undefined : errorName(cause),
          durationMs: Math.round(performance.now() - startedAt),
          errorCode: errorCode(error),
          errorName: errorName(error),
          kind: "network",
          mcpMethod: details.mcpMethod,
          method: details.method,
          toolName: details.toolName,
        },
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
  const toolCallStorage = new AsyncLocalStorage<SentryMcpToolCallState>();
  return new SentryMcpServer(
    {
      cacheToolsList: true,
      clientSessionTimeoutSeconds: 300,
      fetch: createSentryMcpFetch(context, globalThis.fetch, toolCallStorage),
      name: "sentry",
      requestInit: {
        headers: sentryMcpHeaders(connection),
      },
      timeout: 30_000,
      url: connection.mcpUrl,
      useStructuredContent: true,
    },
    context,
    toolCallStorage,
  );
}
