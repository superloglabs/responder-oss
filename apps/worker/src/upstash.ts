import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  MCPServerStdio,
  type CallToolResultContent,
  type MCPCallToolOptions,
  type MCPServer,
  tool,
} from "@openai/agents";
import type { RuntimeUpstashConnection } from "@responder/core/db/investigations";
import { z } from "zod";

const require = createRequire(import.meta.url);
const CLI_SCRIPT = join(
  dirname(require.resolve("@upstash/cli/package.json")),
  "dist/cli.js",
);
const MCP_SCRIPT = join(
  dirname(require.resolve("@upstash/mcp-server/package.json")),
  "dist/index.js",
);
const UPSTASH_FETCH_GUARD = new URL(
  "./upstash-fetch-guard.mjs",
  import.meta.url,
).href;

export const UPSTASH_CONTEXT_MCP_TOOLS = [
  "util_timestamps_to_date",
  "util_dates_to_timestamps",
  "redis_database_list_backups",
  "redis_database_run_redis_commands",
  "redis_database_list_databases",
  "redis_database_get_statistics",
  "qstash_logs_list",
  "qstash_logs_get",
  "qstash_dlq_list",
  "qstash_dlq_get",
  "qstash_schedules_list",
  "workflow_logs_list",
  "workflow_logs_get",
  "workflow_dlq_list",
  "workflow_dlq_get",
] as const;

const UPSTASH_CONTEXT_MCP_TOOL_SET = new Set<string>(
  UPSTASH_CONTEXT_MCP_TOOLS,
);
const READ_ONLY_REDIS_COMMANDS = new Set([
  "BITCOUNT",
  "DBSIZE",
  "EXISTS",
  "GEODIST",
  "GEOHASH",
  "GEOPOS",
  "GEOSEARCH",
  "GET",
  "GETRANGE",
  "HEXISTS",
  "HGET",
  "HLEN",
  "HMGET",
  "HSCAN",
  "HSTRLEN",
  "INFO",
  "JSON.ARRLEN",
  "JSON.GET",
  "JSON.OBJLEN",
  "JSON.TYPE",
  "LINDEX",
  "LLEN",
  "LRANGE",
  "MEMORY",
  "MGET",
  "OBJECT",
  "PTTL",
  "SCAN",
  "SCARD",
  "SISMEMBER",
  "SSCAN",
  "STRLEN",
  "TTL",
  "TYPE",
  "XINFO",
  "XLEN",
  "XRANGE",
  "XREVRANGE",
  "ZCARD",
  "ZCOUNT",
  "ZMSCORE",
  "ZRANGE",
  "ZRANGEBYSCORE",
  "ZREVRANGE",
  "ZREVRANGEBYSCORE",
  "ZSCAN",
  "ZSCORE",
]);
const READ_ONLY_MEMORY_SUBCOMMANDS = new Set([
  "DOCTOR",
  "MALLOC-STATS",
  "STATS",
  "USAGE",
]);
const READ_ONLY_OBJECT_SUBCOMMANDS = new Set([
  "ENCODING",
  "FREQ",
  "IDLETIME",
  "REFCOUNT",
]);
const SENSITIVE_KEY =
  /api.?key|authorization|credential|dsn|header|password|secret|token/i;
const URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu;
const REDACTED = "[redacted]";
const MAX_OUTPUT_LENGTH = 100_000;
const MAX_REDIS_PIPELINE_BYTES = 65_536;
const MAX_UPSTASH_CONCURRENCY = 2;
const SAFE_RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,499}$/;
const UPSTASH_LIST_LIMITS: Partial<
  Record<string, { defaultCount: number; maximumCount: number }>
> = {
  qstash_dlq_list: { defaultCount: 25, maximumCount: 100 },
  qstash_logs_list: { defaultCount: 25, maximumCount: 100 },
  workflow_dlq_list: { defaultCount: 25, maximumCount: 100 },
  workflow_logs_list: { defaultCount: 10, maximumCount: 10 },
};
const UPSTASH_STRING_LIMITS = {
  callerIP: 500,
  callerIp: 500,
  cursor: 4_096,
  failureCallbackState: 500,
  messageId: 500,
  queueName: 500,
  scheduleId: 500,
  topicName: 500,
  url: 8_192,
  workflowRunId: 500,
  workflowUrl: 8_192,
} as const;

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function isBoundedRedisRange(
  start: number,
  stop: number,
  maximumSpan: number,
): boolean {
  const sameDirection =
    (start >= 0 && stop >= 0) || (start < 0 && stop < 0);
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(stop) &&
    sameDirection &&
    stop >= start &&
    stop - start < maximumSpan
  );
}

let activeUpstashOperations = 0;
const pendingUpstashOperations: Array<() => void> = [];

async function withUpstashConcurrencyLimit<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (activeUpstashOperations >= MAX_UPSTASH_CONCURRENCY) {
    await new Promise<void>((resolve) => pendingUpstashOperations.push(resolve));
  } else {
    activeUpstashOperations += 1;
  }
  try {
    return await operation();
  } finally {
    const nextOperation = pendingUpstashOperations.shift();
    if (nextOperation) nextOperation();
    else activeUpstashOperations -= 1;
  }
}

function isSensitiveUrlParameter(parameter: string): boolean {
  const normalized = parameter.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
  if (
    [
      "access_token",
      "api_key",
      "authorization",
      "code",
      "credential",
      "jwt",
      "key",
      "password",
      "secret",
      "session",
      "session_id",
      "sig",
      "signature",
      "token",
    ].includes(normalized)
  ) {
    return true;
  }
  return (
    /(?:^|_)(?:credential|password|secret|sig|signature|token)$/.test(
      normalized,
    ) ||
    /(?:^|_)(?:api|private|signing|x_api)_?key$/.test(normalized)
  );
}

function isSensitiveObjectKey(key: string): boolean {
  if (SENSITIVE_KEY.test(key)) return true;
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
  return (
    normalized === "jwt" ||
    /(?:private|signing)_?key$/.test(normalized) ||
    /session_?(?:id|token)?$/.test(normalized) ||
    /signature$/.test(normalized)
  );
}

function sanitizedUri(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) url.username = REDACTED;
    url.password = "";
    if (url.hash) url.hash = REDACTED;
    for (const key of new Set(url.searchParams.keys())) {
      if (isSensitiveUrlParameter(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizedUris(value: string): string {
  return value
    .replace(URI_PATTERN, sanitizedUri)
    .replace(
      /([?&])([^=&#\s]+)=([^&#\s]*)/gu,
      (match, separator: string, parameter: string) =>
        isSensitiveUrlParameter(parameter)
          ? `${separator}${parameter}=${REDACTED}`
          : match,
    );
}

function sanitizedString(value: string, secrets: readonly string[]): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret.length >= 8) sanitized = sanitized.replaceAll(secret, REDACTED);
  }
  try {
    const encoded = JSON.stringify(
      sanitizeUpstashOutput(JSON.parse(sanitized), secrets),
      null,
      2,
    );
    return encoded.length > MAX_OUTPUT_LENGTH
      ? `${encoded.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`
      : encoded;
  } catch {
    sanitized = sanitizedUris(sanitized).replace(
      /((?:api.?key|authorization|credential|dsn|header|jwt|password|private[_-]?key|secret|session(?:[_-]?(?:id|token))?|signature|signing[_-]?key|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}&]+)/gi,
      `$1${REDACTED}`,
    );
    return sanitized.length > MAX_OUTPUT_LENGTH
      ? `${sanitized.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`
      : sanitized;
  }
}

export function sanitizeUpstashOutput(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (typeof value === "string") return sanitizedString(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUpstashOutput(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveObjectKey(key)
          ? REDACTED
          : sanitizeUpstashOutput(item, secrets),
      ]),
    );
  }
  return value;
}

export function validateUpstashRedisCommands(
  args: Record<string, unknown> | null,
): void {
  if (
    !args ||
    typeof args.database_id !== "string" ||
    !SAFE_RESOURCE_ID.test(args.database_id)
  ) {
    throw new Error("A database_id is required for Redis inspection");
  }
  if ("database_rest_url" in args || "database_rest_token" in args) {
    throw new Error("Direct Redis credentials are not accepted");
  }
  const commands = args.commands;
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 20) {
    throw new Error("Redis inspection requires between 1 and 20 commands");
  }
  let encodedCommands: string;
  try {
    encodedCommands = JSON.stringify(commands);
  } catch {
    throw new Error("Redis commands have an invalid shape or size");
  }
  if (Buffer.byteLength(encodedCommands, "utf8") > MAX_REDIS_PIPELINE_BYTES) {
    throw new Error("Redis inspection commands exceed the 64 KiB request limit");
  }
  for (const command of commands) {
    if (
      !Array.isArray(command) ||
      command.length < 1 ||
      command.length > 30 ||
      command.some(
        (part) => typeof part !== "string" || part.length > 1_000,
      )
    ) {
      throw new Error("Redis commands have an invalid shape or size");
    }
    const name = (command[0] as string).toUpperCase();
    if (!READ_ONLY_REDIS_COMMANDS.has(name)) {
      throw new Error(`Redis command ${name} is not allowed during investigations`);
    }
    const subcommand = (command[1] as string | undefined)?.toUpperCase();
    if (
      name === "MEMORY" &&
      (!subcommand || !READ_ONLY_MEMORY_SUBCOMMANDS.has(subcommand))
    ) {
      throw new Error("Only read-only MEMORY subcommands are allowed");
    }
    if (name === "MEMORY") {
      if (subcommand === "USAGE") {
        const samples = Number(command[4]);
        if (
          (command.length !== 3 && command.length !== 5) ||
          (command.length === 5 &&
            (command[3]?.toUpperCase() !== "SAMPLES" ||
              !Number.isSafeInteger(samples) ||
              samples < 1 ||
              samples > 100))
        ) {
          throw new Error("MEMORY USAGE samples are limited to 100");
        }
      } else if (command.length !== 2) {
        throw new Error(`MEMORY ${subcommand} does not accept arguments`);
      }
    }
    if (
      name === "OBJECT" &&
      (!subcommand || !READ_ONLY_OBJECT_SUBCOMMANDS.has(subcommand))
    ) {
      throw new Error("Only read-only OBJECT subcommands are allowed");
    }
    if (name === "OBJECT" && command.length !== 3) {
      throw new Error(`OBJECT ${subcommand} requires exactly one key`);
    }
    const upper = command.map((part) => part.toUpperCase());
    const optionSearchStart =
      name === "SCAN"
        ? 2
        : ["HSCAN", "SSCAN", "ZSCAN"].includes(name)
          ? 3
          : [
                "LRANGE",
                "XRANGE",
                "XREVRANGE",
                "ZRANGE",
                "ZRANGEBYSCORE",
                "ZREVRANGE",
                "ZREVRANGEBYSCORE",
              ].includes(name)
            ? 4
            : 2;
    const boundedCount = (option: "COUNT" | "LIMIT") => {
      const optionIndex = upper.indexOf(option, optionSearchStart);
      if (optionIndex < 0) {
        throw new Error(`Redis command ${name} requires a bounded ${option}`);
      }
      if (optionIndex !== upper.lastIndexOf(option)) {
        throw new Error(`Redis command ${name} accepts only one ${option}`);
      }
      const countIndex = optionIndex + (option === "LIMIT" ? 2 : 1);
      const count = Number(command[countIndex]);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
        throw new Error(`Redis command ${name} ${option} must be between 1 and 100`);
      }
      if (option === "LIMIT") {
        const offset = Number(command[optionIndex + 1]);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) {
          throw new Error(`Redis command ${name} LIMIT offset is invalid`);
        }
      }
      return optionIndex;
    };
    if (["SCAN", "HSCAN", "SSCAN", "ZSCAN"].includes(name)) {
      boundedCount("COUNT");
    }
    let countOptionIndex: number | undefined;
    if (["GEOSEARCH", "XRANGE", "XREVRANGE"].includes(name)) {
      countOptionIndex = boundedCount("COUNT");
    }
    if (["ZRANGEBYSCORE", "ZREVRANGEBYSCORE"].includes(name)) {
      boundedCount("LIMIT");
    }
    if (["LRANGE", "ZRANGE", "ZREVRANGE"].includes(name)) {
      const usesScoreOrLexRange =
        name !== "LRANGE" &&
        (upper.slice(4).includes("BYSCORE") ||
          upper.slice(4).includes("BYLEX"));
      if (usesScoreOrLexRange) {
        boundedCount("LIMIT");
      } else {
        const start = Number(command[2]);
        const stop = Number(command[3]);
        if (!isBoundedRedisRange(start, stop, 100)) {
          throw new Error(`Redis command ${name} range is limited to 100 items`);
        }
      }
    }
    if (
      name === "GEOSEARCH" &&
      (countOptionIndex === undefined ||
        upper[countOptionIndex + 2] !== "ANY")
    ) {
      throw new Error("Redis command GEOSEARCH requires COUNT with ANY");
    }
    if (
      name === "XINFO" &&
      (subcommand !== "STREAM" || command.length !== 3)
    ) {
      throw new Error("Only bounded XINFO STREAM inspection is allowed");
    }
    if (name === "GETRANGE") {
      const start = Number(command[2]);
      const stop = Number(command[3]);
      if (
        command.length !== 4 ||
        !isBoundedRedisRange(start, stop, 65_536)
      ) {
        throw new Error("Redis command GETRANGE is limited to 64 KiB");
      }
    }
    if (name === "BITCOUNT") {
      const start = Number(command[2]);
      const stop = Number(command[3]);
      const unit = (command[4] ?? "BYTE").toUpperCase();
      const maximumSpan = unit === "BIT" ? 65_536 * 8 : 65_536;
      if (
        (command.length !== 4 && command.length !== 5) ||
        (unit !== "BYTE" && unit !== "BIT") ||
        !isBoundedRedisRange(start, stop, maximumSpan)
      ) {
        throw new Error("Redis command BITCOUNT is limited to 64 KiB");
      }
    }
    const maximumCollectionArguments =
      name === "EXISTS" || name === "MGET"
        ? 21
        : ["GEOHASH", "GEOPOS", "HMGET", "JSON.GET", "ZMSCORE"].includes(
              name,
            )
          ? 22
          : undefined;
    if (
      maximumCollectionArguments !== undefined &&
      command.length > maximumCollectionArguments
    ) {
      throw new Error(`Redis command ${name} is limited to 20 values`);
    }
  }
}

function validateUpstashFilterUrl(parameter: string, value: string): void {
  // These are exact-match filters sent to Upstash's HTTPS API, not network
  // destinations fetched by the worker. HTTP callback URLs are valid log data.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`The Upstash ${parameter} is invalid`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`The Upstash ${parameter} is invalid`);
  }
}

function validateUpstashMcpArgs(
  toolName: string,
  args: Record<string, unknown> | null,
): void {
  if (toolName.startsWith("redis_database_")) {
    for (const parameter of ["database_id", "id"] as const) {
      const value = args?.[parameter];
      if (
        value !== undefined &&
        (typeof value !== "string" || !SAFE_RESOURCE_ID.test(value))
      ) {
        throw new Error(`The Upstash ${parameter} is invalid`);
      }
    }
  }
  if (
    (toolName === "qstash_dlq_get" || toolName === "workflow_dlq_get") &&
    (typeof args?.dlqId !== "string" || !SAFE_RESOURCE_ID.test(args.dlqId))
  ) {
    throw new Error("The Upstash DLQ ID is invalid");
  }
  if (toolName === "redis_database_run_redis_commands") {
    validateUpstashRedisCommands(args);
  }
  if (!toolName.startsWith("qstash_") && !toolName.startsWith("workflow_")) {
    if (toolName === "util_timestamps_to_date") {
      const timestamps = args?.timestamps;
      if (
        !Array.isArray(timestamps) ||
        timestamps.length > 100 ||
        timestamps.some(
          (value) => typeof value !== "number" || !Number.isFinite(value),
        )
      ) {
        throw new Error("Upstash timestamp conversion is limited to 100 values");
      }
    }
    if (toolName === "util_dates_to_timestamps") {
      const dates = args?.dates;
      if (
        !Array.isArray(dates) ||
        dates.length > 100 ||
        dates.some(
          (value) =>
            typeof value !== "string" ||
            value.length > 100 ||
            containsControlCharacter(value),
        )
      ) {
        throw new Error("Upstash date conversion is limited to 100 values");
      }
    }
    return;
  }
  if (args && ("qstash_creds" in args || "local_mode_port" in args)) {
    throw new Error("Custom QStash endpoints and credentials are not accepted");
  }
  if (
    args?.region !== undefined &&
    args.region !== "eu" &&
    args.region !== "us"
  ) {
    throw new Error("Only Upstash EU and US QStash regions are allowed");
  }
  if (
    args?.count !== undefined &&
    (typeof args.count !== "number" ||
      !Number.isInteger(args.count) ||
      args.count < 1 ||
      args.count > 100)
  ) {
    throw new Error("QStash and Workflow list requests are limited to 100 items");
  }
  for (const [parameter, maximum] of Object.entries(UPSTASH_STRING_LIMITS)) {
    const value = args?.[parameter];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        value.length < 1 ||
        value.length > maximum ||
        containsControlCharacter(value))
    ) {
      throw new Error(`The Upstash ${parameter} is invalid`);
    }
    if (
      typeof value === "string" &&
      (parameter === "url" || parameter === "workflowUrl")
    ) {
      validateUpstashFilterUrl(parameter, value);
    }
  }
}

function normalizedUpstashMcpArgs(
  toolName: string,
  args: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const limits = UPSTASH_LIST_LIMITS[toolName];
  if (!limits) return args;
  const normalized = { ...(args ?? {}) };
  const count = normalized.count ?? limits.defaultCount;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > limits.maximumCount
  ) {
    throw new Error(
      `Upstash ${toolName} requests are limited to ${limits.maximumCount} items`,
    );
  }
  normalized.count = count;
  return normalized;
}

function scopeUpstashMcpTool(
  item: Awaited<ReturnType<MCPServer["listTools"]>>[number],
): Awaited<ReturnType<MCPServer["listTools"]>>[number] {
  const schema = item.inputSchema as {
    properties?: Record<string, unknown>;
    required?: unknown;
    [key: string]: unknown;
  };
  const properties = { ...(schema.properties ?? {}) };
  const removedProperties = new Set<string>();
  if (item.name === "redis_database_run_redis_commands") {
    delete properties.database_rest_url;
    delete properties.database_rest_token;
    removedProperties.add("database_rest_url");
    removedProperties.add("database_rest_token");
  }
  if (item.name.startsWith("qstash_") || item.name.startsWith("workflow_")) {
    delete properties.local_mode_port;
    delete properties.qstash_creds;
    removedProperties.add("local_mode_port");
    removedProperties.add("qstash_creds");
    if (properties.region && typeof properties.region === "object") {
      properties.region = {
        ...(properties.region as Record<string, unknown>),
        default: "eu",
        description: "Upstash QStash region",
        enum: ["eu", "us"],
      };
    }
    if (properties.count && typeof properties.count === "object") {
      const limits = UPSTASH_LIST_LIMITS[item.name];
      properties.count = {
        ...(properties.count as Record<string, unknown>),
        ...(limits
          ? {
              default: limits.defaultCount,
              maximum: limits.maximumCount,
            }
          : {}),
        minimum: 1,
      };
    }
    for (const [parameter, maximum] of Object.entries(UPSTASH_STRING_LIMITS)) {
      if (properties[parameter] && typeof properties[parameter] === "object") {
        properties[parameter] = {
          ...(properties[parameter] as Record<string, unknown>),
          maxLength: maximum,
          minLength: 1,
          ...(parameter === "url" || parameter === "workflowUrl"
            ? { pattern: "^https?://" }
            : {}),
        };
      }
    }
  }
  for (const parameter of ["database_id", "id", "dlqId"] as const) {
    if (properties[parameter] && typeof properties[parameter] === "object") {
      properties[parameter] = {
        ...(properties[parameter] as Record<string, unknown>),
        maxLength: 500,
        minLength: 1,
        pattern: SAFE_RESOURCE_ID.source,
      };
    }
  }
  if (item.name === "util_timestamps_to_date" && properties.timestamps) {
    properties.timestamps = {
      ...(properties.timestamps as Record<string, unknown>),
      maxItems: 100,
    };
  }
  if (item.name === "util_dates_to_timestamps" && properties.dates) {
    const dates = properties.dates as Record<string, unknown>;
    properties.dates = {
      ...dates,
      items: {
        ...((dates.items as Record<string, unknown> | undefined) ?? {}),
        maxLength: 100,
      },
      maxItems: 100,
    };
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (property): property is string =>
          typeof property === "string" && !removedProperties.has(property),
      )
    : schema.required;
  return {
    ...item,
    ...(item.name === "redis_database_run_redis_commands"
      ? {
          description:
            "Run bounded, read-only Redis inspection commands on a database selected by database_id. Mutation commands and direct database credentials are rejected.",
        }
      : {}),
    inputSchema: { ...schema, properties, required },
  } as typeof item;
}

function sanitizeMcpResult(
  result: CallToolResultContent,
  secrets: readonly string[],
): CallToolResultContent {
  const boundedRecord = (value: Record<string, unknown>) => {
    const sanitized = sanitizeUpstashOutput(value, secrets) as Record<
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
  };
  const content = result.map((item) =>
    sanitizeUpstashOutput(item, secrets),
  ) as CallToolResultContent;
  if (result._meta) {
    content._meta = boundedRecord(result._meta);
  }
  if (result.structuredContent) {
    content.structuredContent = boundedRecord(result.structuredContent);
  }
  if (result.isError !== undefined) content.isError = result.isError;
  return content;
}

export class ScopedUpstashMcpServer implements MCPServer {
  readonly cacheToolsList = true;
  readonly name: string;
  readonly useStructuredContent = true;

  constructor(
    private readonly server: MCPServer,
    private readonly connection: RuntimeUpstashConnection,
  ) {
    this.name = `upstash-${connection.accountId}`;
  }

  connect(): Promise<void> {
    return this.server.connect();
  }

  close(): Promise<void> {
    return this.server.close();
  }

  async listTools(): ReturnType<MCPServer["listTools"]> {
    const tools = await this.server.listTools();
    return tools
      .filter((item) => UPSTASH_CONTEXT_MCP_TOOL_SET.has(item.name))
      .map(scopeUpstashMcpTool);
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResultContent> {
    if (!UPSTASH_CONTEXT_MCP_TOOL_SET.has(toolName)) {
      throw new Error(`Upstash tool ${toolName} is not available during investigations`);
    }
    const normalizedArgs = normalizedUpstashMcpArgs(toolName, args);
    validateUpstashMcpArgs(toolName, normalizedArgs);
    try {
      const result = await withUpstashConcurrencyLimit(() =>
        this.server.callTool(toolName, normalizedArgs, meta, options),
      );
      return sanitizeMcpResult(result, [this.connection.apiKey]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(sanitizedString(message, [this.connection.apiKey]));
    }
  }

  invalidateToolsCache(): Promise<void> {
    return this.server.invalidateToolsCache();
  }
}

export function createUpstashMcpServer(
  connection: RuntimeUpstashConnection,
): MCPServer {
  const server = new MCPServerStdio({
    args: [MCP_SCRIPT, "--disable-telemetry"],
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    command: process.execPath,
    cwd: dirname(MCP_SCRIPT),
    env: {
      // The upstream server suppresses verbose request/response logs in test
      // mode. Keep the isolated child quiet so inspected Redis values never
      // reach worker logs.
      NODE_ENV: "test",
      NODE_OPTIONS: `--max-old-space-size=128 --import=${UPSTASH_FETCH_GUARD}`,
      RESPONDER_UPSTASH_FETCH_GUARD: "1",
      UPSTASH_API_KEY: connection.apiKey,
      UPSTASH_EMAIL: connection.email,
    },
    name: "upstash-upstream",
    timeout: 30_000,
    toolFilter: {
      allowedToolNames: [...UPSTASH_CONTEXT_MCP_TOOLS],
    },
    useStructuredContent: true,
  });
  return new ScopedUpstashMcpServer(server, connection);
}

export type UpstashCliRunner = (
  args: readonly string[],
  connection: RuntimeUpstashConnection,
) => Promise<unknown>;

export const runUpstashCli: UpstashCliRunner = (args, connection) =>
  withUpstashConcurrencyLimit(async () => {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_SCRIPT, ...args],
        {
          cwd: dirname(CLI_SCRIPT),
          encoding: "utf8",
          env: {
            NODE_ENV: "production",
            NODE_OPTIONS: `--max-old-space-size=128 --import=${UPSTASH_FETCH_GUARD}`,
            NO_COLOR: "1",
            RESPONDER_UPSTASH_FETCH_GUARD: "1",
            UPSTASH_API_KEY: connection.apiKey,
            UPSTASH_EMAIL: connection.email,
          },
          maxBuffer: 1_000_000,
          timeout: 30_000,
        },
        (error, stdout) => {
          if (error) reject(new Error("Upstash CLI request failed"));
          else resolve(stdout);
        },
      );
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = output;
    }
    return sanitizeUpstashOutput(parsed, [connection.apiKey]);
  });

const resourceTypeSchema = z.enum([
  "redis",
  "vector",
  "search",
  "qstash",
  "team",
]);
const statsPeriodSchema = z
  .enum(["1h", "3h", "12h", "1d", "3d", "7d", "30d"])
  .default("1h");

export function upstashInspectionArgs(input: {
  period: z.infer<typeof statsPeriodSchema>;
  resourceId: string;
  resourceType: z.infer<typeof resourceTypeSchema>;
  view: "backups" | "details" | "members" | "statistics";
}): string[] {
  const { period, resourceId, resourceType, view } = input;
  if (!SAFE_RESOURCE_ID.test(resourceId)) {
    throw new Error("The Upstash resource ID is invalid");
  }
  if (resourceType === "redis") {
    if (view === "details") {
      return ["redis", "get", "--db-id", resourceId, "--hide-credentials"];
    }
    if (view === "statistics") {
      return ["redis", "stats", "--db-id", resourceId];
    }
    if (view === "backups") {
      return ["redis", "backup", "list", "--db-id", resourceId];
    }
  }
  if (["vector", "search"].includes(resourceType)) {
    if (view === "details") {
      return [resourceType, "get", "--index-id", resourceId];
    }
    if (view === "statistics") {
      return [
        resourceType,
        "index-stats",
        "--index-id",
        resourceId,
        "--period",
        period,
      ];
    }
  }
  if (resourceType === "qstash") {
    if (view === "details") {
      return ["qstash", "get", "--qstash-id", resourceId];
    }
    if (view === "statistics") {
      return [
        "qstash",
        "stats",
        "--qstash-id",
        resourceId,
        "--period",
        period,
      ];
    }
  }
  if (resourceType === "team" && view === "members") {
    return ["team", "members", "--team-id", resourceId];
  }
  throw new Error(`${view} is not available for ${resourceType} resources`);
}

export function createUpstashCliTools(
  connection: RuntimeUpstashConnection,
  runner: UpstashCliRunner = runUpstashCli,
) {
  return [
    tool({
      name: "list_upstash_resources",
      description:
        "List the connected Upstash account's Redis, Vector, Search, QStash, or team resources. This tool is read-only.",
      parameters: z.object({ resourceType: resourceTypeSchema }),
      async execute({ resourceType }) {
        return runner([resourceType, "list"], connection);
      },
    }),
    tool({
      name: "inspect_upstash_resource",
      description:
        "Inspect details, usage statistics, team members, or Redis backups for one Upstash resource. This tool is read-only.",
      parameters: z.object({
        period: statsPeriodSchema,
        resourceId: z.string().trim().min(1).max(500),
        resourceType: resourceTypeSchema,
        view: z.enum(["details", "statistics", "members", "backups"]),
      }),
      async execute(input) {
        return runner(upstashInspectionArgs(input), connection);
      },
    }),
  ];
}
