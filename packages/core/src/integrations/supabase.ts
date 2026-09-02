import { z } from "zod";
import type { StoredCustomMcpOAuthState } from "./custom-mcp.js";

export const SUPABASE_MCP_ORIGIN = "https://mcp.supabase.com";

export const supabaseAccessModeSchema = z.enum([
  "logs",
  "read_only",
  "read_write",
]);

export type SupabaseAccessMode = z.infer<typeof supabaseAccessModeSchema>;

export const supabaseProjectRefSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]{20}$/u, "Enter a valid 20-character Supabase project ID");

export const supabaseProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  organizationId: z.string().trim().min(1).max(200),
  organizationSlug: z.string().trim().min(1).max(200),
  ref: supabaseProjectRefSchema,
});

export type SupabaseProject = z.infer<typeof supabaseProjectSchema>;

const supabaseOAuthStateSchema = z.object({
  clientInformation: z.record(z.string(), z.unknown()).optional(),
  codeVerifier: z.string().min(1).optional(),
  discoveryState: z.record(z.string(), z.unknown()).optional(),
  tokens: z.record(z.string(), z.unknown()).optional(),
});

export const supabaseCredentialsSchema = z.object({
  accessMode: supabaseAccessModeSchema,
  authType: z.literal("oauth"),
  mcpUrl: z.string().url(),
  oauth: supabaseOAuthStateSchema,
  projectRef: supabaseProjectRefSchema,
});

export interface SupabaseCredentials {
  accessMode: SupabaseAccessMode;
  authType: "oauth";
  mcpUrl: string;
  oauth: StoredCustomMcpOAuthState;
  projectRef: string;
}

export const SUPABASE_ACCESS_MODE_LABELS: Record<SupabaseAccessMode, string> = {
  logs: "Logs only",
  read_only: "Logs and read-only data",
  read_write: "Full database SQL access",
};

export function supabaseDiscoveryMcpUrl(): string {
  const url = new URL("/mcp", SUPABASE_MCP_ORIGIN);
  url.searchParams.set("features", "account");
  url.searchParams.set("read_only", "true");
  return url.toString();
}

export function parseSupabaseProjects(input: unknown): SupabaseProject[] {
  const result = z.object({
    projects: z.array(z.object({
      name: z.string(),
      organization_id: z.string(),
      organization_slug: z.string(),
      ref: supabaseProjectRefSchema,
    })).max(1_000),
  }).parse(input);
  return result.projects.map((project) => supabaseProjectSchema.parse({
    name: project.name,
    organizationId: project.organization_id,
    organizationSlug: project.organization_slug,
    ref: project.ref,
  }));
}

const SUPABASE_LOG_TOOLS = ["get_logs", "query_logs"] as const;
const SUPABASE_DATABASE_TOOLS = [
  "execute_sql",
  "list_extensions",
  "list_tables",
] as const;

export function supabaseAllowedTools(
  accessMode: SupabaseAccessMode,
): readonly string[] {
  return accessMode === "logs"
    ? SUPABASE_LOG_TOOLS
    : [...SUPABASE_LOG_TOOLS, ...SUPABASE_DATABASE_TOOLS];
}

export function hasRequiredSupabaseTools(input: {
  accessMode: SupabaseAccessMode;
  tools: readonly string[];
}): boolean {
  const tools = new Set(input.tools);
  if (!SUPABASE_LOG_TOOLS.some((tool) => tools.has(tool))) return false;
  return input.accessMode === "logs" ||
    SUPABASE_DATABASE_TOOLS.every((tool) => tools.has(tool));
}

export function supabaseMcpUrl(input: {
  accessMode: SupabaseAccessMode;
  projectRef: string;
}): string {
  const projectRef = supabaseProjectRefSchema.parse(input.projectRef);
  const accessMode = supabaseAccessModeSchema.parse(input.accessMode);
  const url = new URL("/mcp", SUPABASE_MCP_ORIGIN);
  url.searchParams.set("project_ref", projectRef);
  url.searchParams.set(
    "features",
    accessMode === "logs" ? "debugging" : "debugging,database",
  );
  if (accessMode !== "read_write") {
    url.searchParams.set("read_only", "true");
  }
  return url.toString();
}

export function parseSupabaseCredentials(input: unknown): SupabaseCredentials {
  const credentials = supabaseCredentialsSchema.parse(input);
  const expectedUrl = supabaseMcpUrl(credentials);
  if (credentials.mcpUrl !== expectedUrl) {
    throw new Error("The stored Supabase MCP scope is invalid");
  }
  return credentials as SupabaseCredentials;
}

export function supabaseExternalAccountId(input: {
  accessMode: SupabaseAccessMode;
  projectRef: string;
}): string {
  return `${supabaseProjectRefSchema.parse(input.projectRef)}:${supabaseAccessModeSchema.parse(input.accessMode)}`;
}

export function supabaseDisplayName(input: {
  accessMode: SupabaseAccessMode;
  projectName?: string;
  projectRef: string;
}): string {
  const projectRef = supabaseProjectRefSchema.parse(input.projectRef);
  const projectName = input.projectName?.trim();
  return `${projectName ? `${projectName} (${projectRef})` : projectRef} · ${SUPABASE_ACCESS_MODE_LABELS[input.accessMode]}`;
}
