import * as Sentry from "@sentry/hono/node";
import { authenticateApiKey } from "../../../../packages/core/src/db/api-keys.js";
import { authenticateOAuthAccessToken } from "../../../../packages/core/src/db/oauth-access-tokens.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { mcpAccessTokenPrefix, mcpOAuthScope } from "../mcp-oauth.js";
import {
  ManagementError,
  type ManagementContext,
  type ManagementOperation,
} from "./operation.js";

export type ManagementResult = {
  body: Record<string, unknown>;
  status: number;
};

// Accepts `Authorization: Bearer <key>` only. Session cookies never
// authenticate management requests. The MCP server also accepts OAuth access
// tokens; the REST API takes API keys only.
export async function authenticateManagementRequest(
  headers: Headers,
  source: ManagementContext["source"],
): Promise<ManagementContext | null> {
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(headers.get("authorization") ?? "");
  const token = match?.[1];
  if (!token) return null;
  let context: ManagementContext | null = null;
  if (source === "mcp" && token.startsWith(mcpAccessTokenPrefix)) {
    const principal = await authenticateOAuthAccessToken(token, {
      prefix: mcpAccessTokenPrefix,
      scope: mcpOAuthScope,
    });
    if (principal) {
      const { clientId, ...rest } = principal;
      context = { ...rest, apiKeyId: null, oauthClientId: clientId, source };
    }
  } else {
    const principal = await authenticateApiKey(token);
    if (principal) context = { ...principal, oauthClientId: null, source };
  }
  if (!context) return null;
  Sentry.setUser({ id: context.user.id, username: context.user.name });
  Sentry.setTag("organization_id", context.organizationId);
  return context;
}

export const unauthorizedBody = {
  code: "unauthorized",
  error: "Send a valid API key as `Authorization: Bearer <key>`. Create keys in Superlog under Settings → API keys.",
};

function errorBody(error: ManagementError): Record<string, unknown> {
  return {
    ...(error.code ? { code: error.code } : {}),
    error: error.message,
    ...(error.issues
      ? {
          issues: error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path.map((part) =>
              typeof part === "symbol" ? String(part) : part
            ),
          })),
        }
      : {}),
  };
}

// Validates the input, runs the operation, and keeps only the documented
// fields of its result.
export async function executeOperation(
  operation: ManagementOperation,
  context: ManagementContext,
  rawInput: unknown,
): Promise<ManagementResult> {
  const started = Date.now();
  let result: ManagementResult;
  try {
    if (
      operation.requiresAutomations &&
      !(await organizationHasCapability(context.organizationId, "automations"))
    ) {
      throw new ManagementError(
        404,
        "Automations are not available in this workspace.",
        "automations_unavailable",
      );
    }
    const input = operation.input.safeParse(rawInput);
    if (!input.success) {
      throw new ManagementError(400, "Invalid request", "invalid_request", input.error.issues);
    }
    const value: unknown = JSON.parse(
      JSON.stringify(await operation.run(context, input.data)),
    );
    const output = operation.output.safeParse(value);
    if (!output.success) {
      console.error(JSON.stringify({
        event: "management_response_invalid",
        issues: output.error.issues.slice(0, 10).map((issue) => ({
          code: issue.code,
          path: issue.path.map(String).join("."),
        })),
        operation: operation.name,
      }));
      throw new Error("Management response did not match its schema");
    }
    result = {
      body: output.data as Record<string, unknown>,
      status: operation.successStatus ?? 200,
    };
  } catch (error) {
    if (error instanceof ManagementError) {
      result = { body: errorBody(error), status: error.status };
    } else {
      Sentry.captureException(error);
      console.error(JSON.stringify({
        errorCode: error instanceof Error ? error.constructor.name : "unknown",
        event: "management_operation_failed",
        operation: operation.name,
      }));
      result = { body: { code: "internal_error", error: "Something went wrong. Try again." }, status: 500 };
    }
  }
  console.info(JSON.stringify({
    apiKeyId: context.apiKeyId,
    oauthClientId: context.oauthClientId,
    durationMs: Date.now() - started,
    event: "management_request",
    operation: operation.name,
    organizationId: context.organizationId,
    source: context.source,
    status: result.status,
  }));
  return result;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
