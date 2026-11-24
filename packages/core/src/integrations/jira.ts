import { z } from "zod";

// Jira Cloud, reached two ways: through Atlassian OAuth 2.0 (3LO) at
// api.atlassian.com with the site's cloud ID, or at the site's own address
// with an Atlassian account's email and API token.
const jiraApiTokenCredentialsSchema = z.object({
  authType: z.literal("api_token"),
  siteUrl: z.string().url(),
  email: z.string().min(1),
  token: z.string().min(1),
});

const jiraOAuthCredentialsSchema = z.object({
  authType: z.literal("jira_oauth"),
  siteUrl: z.string().url(),
  cloudId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  // Milliseconds since the epoch.
  expiresAt: z.number().int().positive(),
  scope: z.string(),
});

const jiraCredentialsSchema = z.discriminatedUnion("authType", [
  jiraApiTokenCredentialsSchema,
  jiraOAuthCredentialsSchema,
]);

export type JiraApiTokenCredentials = z.infer<typeof jiraApiTokenCredentialsSchema>;
export type JiraOAuthCredentials = z.infer<typeof jiraOAuthCredentialsSchema>;
export type JiraCredentials = z.infer<typeof jiraCredentialsSchema>;

export function parseJiraCredentials(input: unknown): JiraCredentials {
  const credentials = jiraCredentialsSchema.parse(input);
  if (parseJiraSiteUrl(credentials.siteUrl) !== credentials.siteUrl) {
    throw new Error("The Jira connection has an unexpected site address");
  }
  return credentials;
}

const siteHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/u;

// A Jira Cloud site's address, such as https://acme.atlassian.net, from
// what someone typed: the site name, its host, or any page on it. Other
// hosts are refused, so requests only ever go to Atlassian.
export function parseJiraSiteUrl(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (/^[a-z0-9-]+$/u.test(value)) value = `${value}.atlassian.net`;
  if (!/^https?:\/\//u.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || !siteHostPattern.test(url.hostname)) return null;
  return `https://${url.hostname}`;
}

export class JiraApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    // Jira's own messages, such as a required field the project needs.
    readonly messages: string[] = [],
  ) {
    super(`Jira ${operation} failed (${status})${messages.length ? `: ${messages.join("; ")}` : ""}`);
    this.name = "JiraApiError";
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

type JiraFetch = (input: string, init: RequestInit) => Promise<Response>;

// What a request needs: the site's address, which issue links use, and either
// an API token or an OAuth access token for the site's cloud ID.
export type JiraAuth =
  | { siteUrl: string; email: string; token: string }
  | { siteUrl: string; cloudId: string; accessToken: string };

export function jiraAuthFromCredentials(credentials: JiraCredentials): JiraAuth {
  return credentials.authType === "jira_oauth"
    ? { siteUrl: credentials.siteUrl, cloudId: credentials.cloudId, accessToken: credentials.accessToken }
    : { siteUrl: credentials.siteUrl, email: credentials.email, token: credentials.token };
}

const ATLASSIAN_API_URL = "https://api.atlassian.com";

function jiraRequestTarget(auth: JiraAuth): { baseUrl: string; authorization: string } {
  if ("accessToken" in auth) {
    return {
      baseUrl: `${ATLASSIAN_API_URL}/ex/jira/${encodeURIComponent(auth.cloudId)}`,
      authorization: `Bearer ${auth.accessToken}`,
    };
  }
  return {
    baseUrl: auth.siteUrl,
    authorization: `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString("base64")}`,
  };
}

const jiraErrorSchema = z.object({
  errorMessages: z.array(z.string()).optional(),
  errors: z.record(z.string(), z.string()).optional(),
});

async function errorMessages(response: Response): Promise<string[]> {
  const parsed = jiraErrorSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return [];
  return [
    ...(parsed.data.errorMessages ?? []),
    ...Object.entries(parsed.data.errors ?? {}).map(([field, message]) => `${field}: ${message}`),
  ].map((message) => message.slice(0, 300)).slice(0, 5);
}

async function callJira(input: {
  auth: JiraAuth;
  operation: string;
  path: string;
  body?: unknown;
  fetch?: JiraFetch;
}): Promise<unknown> {
  const target = jiraRequestTarget(input.auth);
  const response = await (input.fetch ?? fetch)(`${target.baseUrl}${input.path}`, {
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    headers: {
      accept: "application/json",
      authorization: target.authorization,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    method: input.body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new JiraApiError(input.operation, response.status, await errorMessages(response));
  return response.json() as Promise<unknown>;
}

const myselfSchema = z.object({
  accountId: z.string().min(1),
  displayName: z.string().nullish(),
  emailAddress: z.string().nullish(),
});

const serverInfoSchema = z.object({
  serverTitle: z.string().nullish(),
});

// The account the token belongs to, and the site's name.
export async function getJiraAccount(
  auth: JiraAuth,
  fetchImpl?: JiraFetch,
): Promise<{ accountId: string; displayName: string; siteName: string }> {
  const myself = myselfSchema.parse(await callJira({ auth, fetch: fetchImpl, operation: "account lookup", path: "/rest/api/3/myself" }));
  const server = serverInfoSchema.safeParse(
    await callJira({ auth, fetch: fetchImpl, operation: "site lookup", path: "/rest/api/3/serverInfo" }).catch(() => null),
  );
  return {
    accountId: myself.accountId,
    displayName: myself.displayName?.trim() || myself.emailAddress?.trim() || ("email" in auth ? auth.email : myself.accountId),
    siteName: (server.success ? server.data.serverTitle?.trim() : undefined) || new URL(auth.siteUrl).hostname,
  };
}

const projectPageSchema = z.object({
  values: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })),
  isLast: z.boolean().optional(),
});

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

// Projects the account can create issues in, up to 500.
export async function listJiraProjects(auth: JiraAuth, fetchImpl?: JiraFetch): Promise<JiraProject[]> {
  const projects: JiraProject[] = [];
  for (let startAt = 0; startAt < 500; startAt += 100) {
    const query = new URLSearchParams({ action: "create", maxResults: "100", orderBy: "name", startAt: String(startAt) });
    const page = projectPageSchema.parse(await callJira({
      auth, fetch: fetchImpl, operation: "project list", path: `/rest/api/3/project/search?${query}`,
    }));
    projects.push(...page.values.map(({ id, key, name }) => ({ id, key, name })));
    if (page.isLast !== false || page.values.length === 0) break;
  }
  return projects;
}

const issueTypeSchema = z.object({ id: z.string(), name: z.string(), subtask: z.boolean().optional() });
const issueTypesSchema = z.union([
  z.object({ issueTypes: z.array(issueTypeSchema) }).transform((value) => value.issueTypes),
  z.object({ values: z.array(issueTypeSchema) }).transform((value) => value.values),
]);

export interface JiraIssueType {
  id: string;
  name: string;
}

// The issue types a project lets the account create, without subtasks,
// which need a parent issue.
export async function listJiraIssueTypes(
  auth: JiraAuth,
  projectId: string,
  fetchImpl?: JiraFetch,
): Promise<JiraIssueType[]> {
  const types = issueTypesSchema.parse(await callJira({
    auth,
    fetch: fetchImpl,
    operation: "issue type list",
    path: `/rest/api/3/issue/createmeta/${encodeURIComponent(projectId)}/issuetypes?maxResults=100`,
  }));
  return types.filter((type) => !type.subtask).map(({ id, name }) => ({ id, name }));
}

// Atlassian Document Format, the rich text Jira Cloud stores.
export type JiraDocumentNode = Record<string, unknown>;

export function jiraDocument(content: JiraDocumentNode[]): JiraDocumentNode {
  return { type: "doc", version: 1, content };
}

const createdIssueSchema = z.object({ id: z.string(), key: z.string() });

export interface JiraIssue {
  id: string;
  key: string;
  url: string;
}

// Jira caps a summary at 255 characters. It is cut by code point, so an
// emoji is never split in half.
export function jiraSummary(text: string): string {
  const characters = [...text.replace(/\s+/gu, " ").trim()];
  return characters.length > 255 ? `${characters.slice(0, 254).join("").trimEnd()}…` : characters.join("");
}

export async function createJiraIssue(input: {
  auth: JiraAuth;
  projectId: string;
  issueTypeId: string;
  summary: string;
  description: JiraDocumentNode;
  fetch?: JiraFetch;
}): Promise<JiraIssue> {
  const created = createdIssueSchema.parse(await callJira({
    auth: input.auth,
    fetch: input.fetch,
    operation: "issue creation",
    path: "/rest/api/3/issue",
    body: {
      fields: {
        project: { id: input.projectId },
        issuetype: { id: input.issueTypeId },
        summary: jiraSummary(input.summary),
        description: input.description,
      },
    },
  }));
  return { id: created.id, key: created.key, url: jiraIssueUrl(input.auth.siteUrl, created.key) };
}

export function jiraIssueUrl(siteUrl: string, key: string): string {
  return `${siteUrl}/browse/${encodeURIComponent(key)}`;
}

const searchSchema = z.object({
  issues: z.array(z.object({
    key: z.string(),
    fields: z.object({
      summary: z.string().nullish(),
      created: z.string().nullish(),
      updated: z.string().nullish(),
      resolutiondate: z.string().nullish(),
      status: z.object({
        name: z.string(),
        statusCategory: z.object({ key: z.string() }).nullish(),
      }).nullish(),
    }),
  })),
});

export interface JiraSearchResult {
  key: string;
  url: string;
  summary: string;
  createdAt: string | null;
  updatedAt: string | null;
  resolvedAt: string | null;
  status: string | null;
  done: boolean;
}

// Words for a JQL text search. Characters with meaning to Jira's search are
// replaced, so the words cannot change the query.
export function jiraTextQuery(text: string): string {
  return text.replace(/[\\"'+\-&|!(){}[\]^~*?:/]/gu, " ").replace(/\s+/gu, " ").trim();
}

// Issues whose text matches the words, newest first.
export async function searchJiraIssues(input: {
  auth: JiraAuth;
  text: string;
  limit?: number;
  fetch?: JiraFetch;
}): Promise<JiraSearchResult[]> {
  const words = jiraTextQuery(input.text);
  if (!words) return [];
  const result = searchSchema.parse(await callJira({
    auth: input.auth,
    fetch: input.fetch,
    operation: "issue search",
    path: "/rest/api/3/search/jql",
    body: {
      jql: `text ~ "${words}" ORDER BY created DESC`,
      fields: ["summary", "status", "created", "updated", "resolutiondate"],
      maxResults: input.limit ?? 25,
    },
  }));
  return result.issues.map((issue) => ({
    key: issue.key,
    url: jiraIssueUrl(input.auth.siteUrl, issue.key),
    summary: issue.fields.summary ?? "",
    createdAt: issue.fields.created ?? null,
    updatedAt: issue.fields.updated ?? null,
    resolvedAt: issue.fields.resolutiondate ?? null,
    status: issue.fields.status?.name ?? null,
    done: issue.fields.status?.statusCategory?.key === "done",
  }));
}

// --- OAuth 2.0 (3LO) --------------------------------------------------------

export const JIRA_OAUTH_AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
export const JIRA_OAUTH_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
export const JIRA_ACCESSIBLE_RESOURCES_URL = `${ATLASSIAN_API_URL}/oauth/token/accessible-resources`;
// Reading projects, issue types, and issues, and creating issues. offline_access
// returns a refresh token.
export const JIRA_OAUTH_SCOPES = ["read:jira-work", "write:jira-work", "offline_access"] as const;
const requiredSiteScopes = ["read:jira-work", "write:jira-work"];

interface JiraOAuthApp {
  clientId: string;
  clientSecret: string;
}

function jiraOAuthApp(environment: NodeJS.ProcessEnv = process.env): JiraOAuthApp | null {
  const clientId = environment.JIRA_CLIENT_ID?.trim();
  const clientSecret = environment.JIRA_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function jiraOAuthConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  return jiraOAuthApp(environment) !== null;
}

function requireJiraOAuthApp(): JiraOAuthApp {
  const app = jiraOAuthApp();
  if (!app) throw new Error("Jira application credentials are not configured");
  return app;
}

// Atlassian shows its consent screen every time, where the member picks the
// site to grant.
// Spaces are sent as %20, as in Atlassian's own authorization URLs, rather
// than the + that URLSearchParams writes.
export function jiraAuthorizeUrl(input: { redirectUri: string; state: string }): string {
  const parameters: Array<[string, string]> = [
    ["audience", "api.atlassian.com"],
    ["client_id", requireJiraOAuthApp().clientId],
    ["scope", JIRA_OAUTH_SCOPES.join(" ")],
    ["redirect_uri", input.redirectUri],
    ["state", input.state],
    ["response_type", "code"],
    ["prompt", "consent"],
  ];
  const query = parameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `${JIRA_OAUTH_AUTHORIZE_URL}?${query}`;
}

// The token endpoint refused the grant: the refresh token expired, was
// rotated away, or the member revoked access. Only reconnecting fixes it.
export class JiraOAuthGrantError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`Jira OAuth refused the grant (${status}${code ? `, ${code}` : ""})`);
    this.name = "JiraOAuthGrantError";
  }
}

const jiraTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  scope: z.string().optional(),
});

const jiraTokenErrorSchema = z.object({ error: z.string().optional() });

export interface JiraOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

// Shorter than the 15-second credential refresh lease, so a refresh gives up
// before another caller can take the lease and redeem the same refresh token.
const JIRA_TOKEN_TIMEOUT_MS = 8_000;

async function requestJiraToken(
  parameters: Record<string, string>,
  fetchImpl: JiraFetch = fetch,
): Promise<JiraOAuthTokens> {
  const { clientId, clientSecret } = requireJiraOAuthApp();
  const response = await fetchImpl(JIRA_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...parameters }),
    redirect: "error",
    signal: AbortSignal.timeout(JIRA_TOKEN_TIMEOUT_MS),
  });
  if (!response.ok) {
    const parsed = jiraTokenErrorSchema.safeParse(await response.json().catch(() => null));
    const code = parsed.success ? parsed.data.error ?? null : null;
    if (response.status === 400 || response.status === 403) {
      throw new JiraOAuthGrantError(response.status, code);
    }
    throw new Error(`Jira OAuth returned HTTP ${response.status}`);
  }
  const token = jiraTokenSchema.parse(await response.json());
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1_000,
    scope: token.scope ?? "",
  };
}

export async function exchangeJiraOAuthCode(input: {
  code: string;
  redirectUri: string;
  fetch?: JiraFetch;
}): Promise<JiraOAuthTokens> {
  return requestJiraToken({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  }, input.fetch);
}

export function jiraAccessTokenNeedsRefresh(credentials: JiraOAuthCredentials, now = Date.now()): boolean {
  return credentials.expiresAt <= now + 60_000;
}

// Atlassian rotates the refresh token on every refresh, so the caller must
// store the returned credentials before anything else uses the old ones.
export async function refreshJiraOAuthCredentials(
  credentials: JiraOAuthCredentials,
  fetchImpl?: JiraFetch,
): Promise<JiraOAuthCredentials> {
  const tokens = await requestJiraToken({
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  }, fetchImpl);
  return { ...credentials, ...tokens };
}

const accessibleResourcesSchema = z.array(z.object({
  id: z.string().min(1),
  url: z.string(),
  name: z.string().nullish(),
  scopes: z.array(z.string()).default([]),
}));

export interface JiraSite {
  cloudId: string;
  siteUrl: string;
  name: string;
}

// The Jira Cloud sites the token was granted, with the scopes Signal needs.
// Sites on other hosts are dropped, so requests only ever go to Atlassian.
export async function listJiraAccessibleSites(accessToken: string, fetchImpl: JiraFetch = fetch): Promise<JiraSite[]> {
  const response = await fetchImpl(JIRA_ACCESSIBLE_RESOURCES_URL, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new JiraApiError("site list", response.status, await errorMessages(response));
  const sites: JiraSite[] = [];
  for (const resource of accessibleResourcesSchema.parse(await response.json())) {
    const siteUrl = parseJiraSiteUrl(resource.url);
    if (!siteUrl || !requiredSiteScopes.every((scope) => resource.scopes.includes(scope))) continue;
    if (sites.some((site) => site.cloudId === resource.id)) continue;
    sites.push({ cloudId: resource.id, siteUrl, name: resource.name?.trim() || new URL(siteUrl).hostname });
  }
  return sites;
}

export function jiraOAuthCredentials(tokens: JiraOAuthTokens, site: JiraSite): JiraOAuthCredentials {
  return { authType: "jira_oauth", siteUrl: site.siteUrl, cloudId: site.cloudId, ...tokens };
}
