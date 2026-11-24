import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJiraIssue,
  jiraAuthorizeUrl,
  JiraOAuthGrantError,
  listJiraAccessibleSites,
  refreshJiraOAuthCredentials,
  type JiraOAuthCredentials,
  getJiraAccount,
  JiraApiError,
  jiraDocument,
  jiraSummary,
  jiraTextQuery,
  listJiraIssueTypes,
  listJiraProjects,
  parseJiraCredentials,
  parseJiraSiteUrl,
  searchJiraIssues,
} from "./jira.js";

const auth = { siteUrl: "https://example.atlassian.net", email: "dev@example.com", token: "test-token" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function call(fetch: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = fetch.mock.calls[index] as unknown as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(String(init.body)) as unknown : undefined };
}

describe("parseJiraSiteUrl", () => {
  it("accepts a site name, host, or page on a Jira Cloud site", () => {
    expect(parseJiraSiteUrl("example")).toBe("https://example.atlassian.net");
    expect(parseJiraSiteUrl("Example.atlassian.net")).toBe("https://example.atlassian.net");
    expect(parseJiraSiteUrl("https://example.atlassian.net/jira/software/projects/OPS/boards/1")).toBe("https://example.atlassian.net");
    expect(parseJiraSiteUrl(" http://example.atlassian.net ")).toBe("https://example.atlassian.net");
  });

  it("refuses other hosts and addresses with credentials or ports", () => {
    expect(parseJiraSiteUrl("")).toBeNull();
    expect(parseJiraSiteUrl("https://jira.example.com")).toBeNull();
    expect(parseJiraSiteUrl("https://example.atlassian.net.evil.test")).toBeNull();
    expect(parseJiraSiteUrl("https://user:pass@example.atlassian.net")).toBeNull();
    expect(parseJiraSiteUrl("https://example.atlassian.net:8443")).toBeNull();
    expect(parseJiraSiteUrl("https://a.b.atlassian.net")).toBeNull();
  });
});

describe("parseJiraCredentials", () => {
  it("refuses stored credentials for another host", () => {
    expect(() => parseJiraCredentials({ authType: "api_token", ...auth, siteUrl: "https://jira.example.com" })).toThrow();
    expect(parseJiraCredentials({ authType: "api_token", ...auth })).toEqual({ authType: "api_token", ...auth });
  });
});

describe("Jira API", () => {
  it("reads the token's account with basic authentication", async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith("/myself")
      ? jsonResponse({ accountId: "account-1", displayName: "Dev Example" })
      : jsonResponse({ serverTitle: "Example Jira" }));

    await expect(getJiraAccount(auth, fetch)).resolves.toEqual({
      accountId: "account-1", displayName: "Dev Example", siteName: "Example Jira",
    });
    const { url, init } = call(fetch);
    expect(url).toBe("https://example.atlassian.net/rest/api/3/myself");
    expect(init.headers).toMatchObject({ authorization: `Basic ${Buffer.from("dev@example.com:test-token").toString("base64")}` });
    expect(init.redirect).toBe("error");
  });

  it("reports a rejected token", async () => {
    const error = await getJiraAccount(auth, async () => jsonResponse({}, 401)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JiraApiError);
    expect((error as JiraApiError).unauthorized).toBe(true);
  });

  it("lists the projects the account can create issues in, page by page", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: "10000", key: "OPS", name: "Operations" }], isLast: false }))
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: "10001", key: "WEB", name: "Web" }], isLast: true }));

    await expect(listJiraProjects(auth, fetch)).resolves.toEqual([
      { id: "10000", key: "OPS", name: "Operations" },
      { id: "10001", key: "WEB", name: "Web" },
    ]);
    expect(call(fetch, 0).url).toContain("action=create");
    expect(call(fetch, 1).url).toContain("startAt=100");
  });

  it("lists a project's issue types without subtasks", async () => {
    const fetch = vi.fn(async () => jsonResponse({
      issueTypes: [{ id: "1", name: "Bug", subtask: false }, { id: "2", name: "Sub-task", subtask: true }],
    }));

    await expect(listJiraIssueTypes(auth, "10000", fetch)).resolves.toEqual([{ id: "1", name: "Bug" }]);
    expect(call(fetch).url).toBe("https://example.atlassian.net/rest/api/3/issue/createmeta/10000/issuetypes?maxResults=100");
  });

  it("creates an issue and returns its address", async () => {
    const fetch = vi.fn(async () => jsonResponse({ id: "10010", key: "OPS-12", self: "https://example.atlassian.net/rest/api/3/issue/10010" }, 201));
    const description = jiraDocument([{ type: "paragraph", content: [{ type: "text", text: "Details" }] }]);

    await expect(createJiraIssue({ auth, projectId: "10000", issueTypeId: "1", summary: "Checkout fails", description, fetch }))
      .resolves.toEqual({ id: "10010", key: "OPS-12", url: "https://example.atlassian.net/browse/OPS-12" });
    expect(call(fetch).body).toEqual({
      fields: { project: { id: "10000" }, issuetype: { id: "1" }, summary: "Checkout fails", description },
    });
  });

  it("keeps Jira's reasons when it refuses an issue", async () => {
    const fetch = async () => jsonResponse({ errorMessages: [], errors: { components: "Component/s is required." } }, 400);
    const error = await createJiraIssue({
      auth, projectId: "10000", issueTypeId: "1", summary: "Checkout fails", description: jiraDocument([]), fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JiraApiError);
    expect((error as JiraApiError).messages).toEqual(["components: Component/s is required."]);
  });

  it("searches issue text with the query's special characters removed", async () => {
    const fetch = vi.fn(async () => jsonResponse({
      issues: [{
        key: "OPS-3",
        fields: {
          summary: "Payments timeout",
          created: "2026-11-01T10:00:00.000+0000",
          updated: "2026-11-02T10:00:00.000+0000",
          resolutiondate: null,
          status: { name: "Done", statusCategory: { key: "done" } },
        },
      }],
    }));

    await expect(searchJiraIssues({ auth, text: 'payments "timeout" OR (x)', fetch })).resolves.toEqual([{
      key: "OPS-3",
      url: "https://example.atlassian.net/browse/OPS-3",
      summary: "Payments timeout",
      createdAt: "2026-11-01T10:00:00.000+0000",
      updatedAt: "2026-11-02T10:00:00.000+0000",
      resolvedAt: null,
      status: "Done",
      done: true,
    }]);
    expect(call(fetch).body).toMatchObject({ jql: 'text ~ "payments timeout OR x" ORDER BY created DESC' });
  });

  it("does not search for nothing", async () => {
    const fetch = vi.fn();
    await expect(searchJiraIssues({ auth, text: '"()"', fetch })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("jiraSummary and jiraTextQuery", () => {
  it("flattens and caps a summary at 255 characters", () => {
    expect(jiraSummary("a\n b")).toBe("a b");
    expect(jiraSummary("x".repeat(300))).toHaveLength(255);
  });

  it("never splits an emoji when cutting a summary", () => {
    const summary = jiraSummary(`${"x".repeat(253)}🔥🔥🔥`);
    expect([...summary]).toHaveLength(255);
    expect(summary).toBe(`${"x".repeat(253)}🔥…`);
  });

  it("keeps plain words", () => {
    expect(jiraTextQuery("checkout 500 errors")).toBe("checkout 500 errors");
  });
});

describe("Jira OAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const oauthCredentials: JiraOAuthCredentials = {
    authType: "jira_oauth",
    siteUrl: "https://example.atlassian.net",
    cloudId: "cloud-1",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    scope: "read:jira-work write:jira-work offline_access",
  };

  it("parses stored OAuth credentials", () => {
    expect(parseJiraCredentials(oauthCredentials)).toEqual(oauthCredentials);
    expect(() => parseJiraCredentials({ ...oauthCredentials, siteUrl: "https://jira.example.com" })).toThrow();
  });

  it("asks for a refresh token and shows the consent screen", () => {
    vi.stubEnv("JIRA_CLIENT_ID", "jira-client");
    vi.stubEnv("JIRA_CLIENT_SECRET", "jira-secret");
    const url = new URL(jiraAuthorizeUrl({ redirectUri: "https://app.example/api/integrations/jira/callback", state: "state-1" }));
    expect(url.searchParams.get("scope")).toBe("read:jira-work write:jira-work offline_access");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("client_id")).toBe("jira-client");
    expect(url.search).toContain("scope=read%3Ajira-work%20write%3Ajira-work%20offline_access");
  });

  it("calls the site through api.atlassian.com with the access token", async () => {
    const fetch = vi.fn(async () => jsonResponse({ values: [], isLast: true }));
    await listJiraProjects({ siteUrl: "https://example.atlassian.net", cloudId: "cloud-1", accessToken: "access-1" }, fetch);
    const { url, init } = call(fetch);
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/project/search?action=create&maxResults=100&orderBy=name&startAt=0");
    expect(init.headers).toMatchObject({ authorization: "Bearer access-1" });
    expect(init.redirect).toBe("error");
  });

  it("links issues on the site, not the API host", async () => {
    const fetch = vi.fn(async () => jsonResponse({ id: "10001", key: "OPS-7" }));
    const issue = await createJiraIssue({
      auth: { siteUrl: "https://example.atlassian.net", cloudId: "cloud-1", accessToken: "access-1" },
      projectId: "10000", issueTypeId: "10004", summary: "Broken", description: jiraDocument([]), fetch,
    });
    expect(issue.url).toBe("https://example.atlassian.net/browse/OPS-7");
  });

  it("keeps the rotated refresh token", async () => {
    vi.stubEnv("JIRA_CLIENT_ID", "jira-client");
    vi.stubEnv("JIRA_CLIENT_SECRET", "jira-secret");
    const fetch = vi.fn(async () => jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: "read:jira-work" }));

    const refreshed = await refreshJiraOAuthCredentials(oauthCredentials, fetch);

    expect(refreshed).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", cloudId: "cloud-1", siteUrl: "https://example.atlassian.net" });
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    const { url, body } = call(fetch);
    expect(url).toBe("https://auth.atlassian.com/oauth/token");
    expect(body).toEqual({ client_id: "jira-client", client_secret: "jira-secret", grant_type: "refresh_token", refresh_token: "old-refresh" });
  });

  it("reports a refused refresh as a grant error", async () => {
    vi.stubEnv("JIRA_CLIENT_ID", "jira-client");
    vi.stubEnv("JIRA_CLIENT_SECRET", "jira-secret");
    const refused = await refreshJiraOAuthCredentials(oauthCredentials, async () => jsonResponse({ error: "invalid_grant" }, 403)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(JiraOAuthGrantError);
    const unavailable = await refreshJiraOAuthCredentials(oauthCredentials, async () => jsonResponse({}, 503)).catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(Error);
    expect(unavailable).not.toBeInstanceOf(JiraOAuthGrantError);
  });

  it("lists granted Jira sites with Signal's scopes on Atlassian hosts only", async () => {
    const fetch = vi.fn(async () => jsonResponse([
      { id: "cloud-1", url: "https://example.atlassian.net", name: "Example", scopes: ["read:jira-work", "write:jira-work"] },
      { id: "cloud-2", url: "https://read-only.atlassian.net", name: "Read only", scopes: ["read:jira-work"] },
      { id: "cloud-3", url: "https://evil.example", name: "Elsewhere", scopes: ["read:jira-work", "write:jira-work"] },
    ]));

    await expect(listJiraAccessibleSites("access-1", fetch)).resolves.toEqual([
      { cloudId: "cloud-1", siteUrl: "https://example.atlassian.net", name: "Example" },
    ]);
    expect(call(fetch).url).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
  });
});
