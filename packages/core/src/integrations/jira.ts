import { z } from "zod";

// Jira Cloud, reached at the site's own address with an Atlassian account's
// email and API token.
const jiraCredentialsSchema = z.object({
  authType: z.literal("api_token"),
  siteUrl: z.string().url(),
  email: z.string().min(1),
  token: z.string().min(1),
});

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

interface JiraAuth {
  siteUrl: string;
  email: string;
  token: string;
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
  const authorization = Buffer.from(`${input.auth.email}:${input.auth.token}`).toString("base64");
  const response = await (input.fetch ?? fetch)(`${input.auth.siteUrl}${input.path}`, {
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    headers: {
      accept: "application/json",
      authorization: `Basic ${authorization}`,
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
    displayName: myself.displayName?.trim() || myself.emailAddress?.trim() || auth.email,
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

// Jira caps a summary at 255 characters.
export function jiraSummary(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 255 ? `${flat.slice(0, 254).trimEnd()}…` : flat;
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
