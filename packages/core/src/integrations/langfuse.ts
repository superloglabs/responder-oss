import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { safeCustomMcpFetch } from "./custom-mcp.js";

export const langfuseCloudDeployments = [
  {
    id: "cloud_eu",
    name: "Langfuse Cloud (EU)",
    baseUrl: "https://cloud.langfuse.com",
  },
  {
    id: "cloud_us",
    name: "Langfuse Cloud (US)",
    baseUrl: "https://us.cloud.langfuse.com",
  },
  {
    id: "cloud_jp",
    name: "Langfuse Cloud (Japan)",
    baseUrl: "https://jp.cloud.langfuse.com",
  },
  {
    id: "cloud_hipaa",
    name: "Langfuse Cloud (HIPAA US)",
    baseUrl: "https://hipaa.cloud.langfuse.com",
  },
] as const;

export const langfuseCredentialsSchema = z.object({
  authType: z.literal("basic"),
  baseUrl: z.string().url(),
  projectId: z.string().min(1),
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
});

export type LangfuseCredentials = z.infer<typeof langfuseCredentialsSchema>;

const REQUIRED_LANGFUSE_MCP_TOOLS = new Set([
  "getObservation",
  "listObservations",
]);

export function normalizeLangfuseBaseUrl(input: string): string {
  const url = new URL(input);
  if (url.username || url.password) {
    throw new Error("Langfuse URLs cannot contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Enter the Langfuse deployment URL without a query or fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("Enter the Langfuse deployment URL without an API path");
  }
  return url.origin;
}

export function langfuseProjectsUrl(baseUrl: string): string {
  return new URL("/api/public/projects", normalizeLangfuseBaseUrl(baseUrl)).toString();
}

export function langfuseMcpUrl(baseUrl: string): string {
  return new URL("/api/public/mcp", normalizeLangfuseBaseUrl(baseUrl)).toString();
}

export function langfuseBasicAuthorization(input: {
  publicKey: string;
  secretKey: string;
}): string {
  return `Basic ${Buffer.from(
    `${input.publicKey}:${input.secretKey}`,
    "utf8",
  ).toString("base64")}`;
}

export function parseLangfuseCredentials(
  value: Record<string, unknown>,
): LangfuseCredentials {
  const credentials = langfuseCredentialsSchema.parse(value);
  return {
    ...credentials,
    baseUrl: normalizeLangfuseBaseUrl(credentials.baseUrl),
  };
}

export class LangfuseMcpUnavailableError extends Error {
  constructor() {
    super("This Langfuse deployment does not provide the required MCP observation tools");
    this.name = "LangfuseMcpUnavailableError";
  }
}

export async function verifyLangfuseMcpConnection(input: {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}): Promise<void> {
  const transport = new StreamableHTTPClientTransport(
    new URL(langfuseMcpUrl(input.baseUrl)),
    {
      fetch: safeCustomMcpFetch,
      requestInit: {
        headers: {
          authorization: langfuseBasicAuthorization(input),
        },
      },
    },
  );
  const client = new Client({ name: "responder-connection-check", version: "1" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    if ([...REQUIRED_LANGFUSE_MCP_TOOLS].some((name) => !names.has(name))) {
      throw new LangfuseMcpUnavailableError();
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}
