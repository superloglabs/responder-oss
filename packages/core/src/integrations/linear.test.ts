import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeLinearOAuthCode,
  createLinearIssue,
  ensureLinearIssueLabel,
  findLinearIssueById,
  linearAuthorizeUrl,
  linearIssueLabelName,
  linearTicketFollowupInstruction,
  parseLinearOAuthCredentials,
  refreshLinearOAuthCredentials,
  renderLinearIssueDescription,
} from "./linear.js";

const issue = {
  id: "7ad47787-0efa-4ce3-b1d7-2f14bcfcd4e9",
  title: "Checkout returns 503",
  description: "The checkout route throws for missing carts.",
  severity: "SEV-2" as const,
  remediation: "Handle an absent cart before reading it.",
  evidence: [
    {
      source: "github" as const,
      title: "Unchecked cart",
      detail: "The handler reads cart.id without a guard.",
      file: "src/checkout.ts",
      line: 42,
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const workspaceLabel = { id: "responder-label", isGroup: false, team: null };

const createdIssue = {
  issueCreate: {
    success: true,
    issue: {
      id: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
      identifier: "OPS-42",
      url: "https://linear.app/example/issue/OPS-42/checkout-returns-503",
    },
  },
};

type LinearApiReply = Record<string, unknown> | Error | (() => Record<string, unknown>);

// Answers each Linear GraphQL request by its operation name. An Error reply
// becomes a GraphQL error.
function linearApi(replies: Record<string, LinearApiReply>) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const operation = operationName(init);
    const reply = replies[operation];
    if (!reply) throw new Error(`Unexpected Linear operation ${operation}`);
    if (reply instanceof Error) {
      return Response.json({ errors: [{ message: reply.message }] });
    }
    return Response.json({ data: typeof reply === "function" ? reply() : reply });
  });
}

function operationName(init: RequestInit | undefined): string {
  const query = JSON.parse(String(init?.body)).query as string;
  return /(?:query|mutation) (\w+)/u.exec(query)?.[1] ?? "";
}

function operations(fetchImpl: ReturnType<typeof linearApi>): string[] {
  return fetchImpl.mock.calls.map(([, init]) => operationName(init));
}

function requestFor(
  fetchImpl: ReturnType<typeof linearApi>,
  operation: string,
): { body: string; headers: Record<string, string> } {
  const init = fetchImpl.mock.calls[operations(fetchImpl).indexOf(operation)]![1];
  return init as { body: string; headers: Record<string, string> };
}

describe("Linear OAuth", () => {
  it("requests read and write access with PKCE", () => {
    vi.stubEnv("LINEAR_CLIENT_ID", "linear-client");
    vi.stubEnv("LINEAR_CLIENT_SECRET", "linear-secret");

    const url = new URL(linearAuthorizeUrl({
      codeChallenge: "challenge",
      redirectUri: "https://responder.example/api/integrations/linear/callback",
      state: "connection-state",
    }));

    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("linear-client");
    expect(url.searchParams.get("scope")).toBe("read,write");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges an authorization code for refreshable API credentials", async () => {
    vi.stubEnv("LINEAR_CLIENT_ID", "linear-client");
    vi.stubEnv("LINEAR_CLIENT_SECRET", "linear-secret");
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      access_token: "access-token",
      expires_in: 86_399,
      refresh_token: "refresh-token",
      scope: "read write",
      token_type: "Bearer",
    }));

    const credentials = await exchangeLinearOAuthCode({
      authorizationCode: "authorization-code",
      codeVerifier: "verifier",
      fetchImpl,
      redirectUri: "https://responder.example/api/integrations/linear/callback",
    });

    expect(parseLinearOAuthCredentials(credentials).accessToken).toBe(
      "access-token",
    );
    const [, request] = fetchImpl.mock.calls[0]!;
    const body = new URLSearchParams(request.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("client_secret")).toBe("linear-secret");
  });

  it("rotates the refresh token", async () => {
    vi.stubEnv("LINEAR_CLIENT_ID", "linear-client");
    vi.stubEnv("LINEAR_CLIENT_SECRET", "linear-secret");
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      access_token: "new-access-token",
      expires_in: 86_399,
      refresh_token: "new-refresh-token",
      scope: "read write",
      token_type: "Bearer",
    }));

    const refreshed = await refreshLinearOAuthCredentials({
      credentials: {
        accessToken: "old-access-token",
        authType: "linear_oauth",
        expiresAt: Date.now() - 1,
        mcpUrl: "https://mcp.linear.app/mcp",
        refreshToken: "old-refresh-token",
        scope: "read write",
        tokenType: "Bearer",
      },
      fetchImpl,
    });

    expect(refreshed.refreshToken).toBe("new-refresh-token");
    const [, request] = fetchImpl.mock.calls[0]!;
    expect(new URLSearchParams(request.body).get("refresh_token")).toBe(
      "old-refresh-token",
    );
  });

});

describe("Linear ticket templates", () => {
  it("renders the final Responder ID, link, issue fields, and evidence", () => {
    const rendered = renderLinearIssueDescription({
      issue,
      issueBaseUrl: "https://responder.example",
      template:
        "{{issue_id}} {{issue_url}}\n{{title}}\n{{severity}}\n{{description}}\n{{evidence}}\n{{remediation}}",
    });
    expect(rendered).toContain(
      "7ad47787-0efa-4ce3-b1d7-2f14bcfcd4e9 https://responder.example/issues/7ad47787-0efa-4ce3-b1d7-2f14bcfcd4e9",
    );
    expect(rendered).toContain(issue.title);
    expect(rendered).toContain(issue.description);
    expect(rendered).toContain(issue.remediation);
    expect(rendered).toContain("src/checkout.ts:42");
    expect(rendered).not.toContain("[source](src/checkout.ts:42)");
  });

  it("does not expand placeholders found inside issue content", () => {
    expect(renderLinearIssueDescription({
      issue: { ...issue, description: "Keep {{severity}} literally." },
      issueBaseUrl: "https://responder.example",
      template: "{{description}} — {{severity}}",
    })).toBe("Keep {{severity}} literally. — SEV-2");
  });

  it("only instructs ticket creation for enabled agents with new issues", () => {
    expect(
      linearTicketFollowupInstruction({
        requests: [{
          requestId: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
          issueId: issue.id,
          title: issue.title,
          description: issue.description,
          severity: issue.severity,
        }],
      }),
    ).toContain("create_linear_ticket");
    expect(
      linearTicketFollowupInstruction({
        requests: [],
      }),
    ).toBeNull();
  });
});

describe("Linear issue API", () => {
  it("creates an issue with a stable ID and the selected team and project", async () => {
    const fetchImpl = linearApi({
      ResponderLinearIssueLabel: { issueLabels: { nodes: [workspaceLabel] } },
      ResponderCreateLinearIssue: createdIssue,
    });
    const created = await createLinearIssue({
      accessToken: "linear-token",
      description: "Rendered description",
      fetchImpl,
      id: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
      projectId: "project-id",
      teamId: "team-id",
      title: issue.title,
    });

    expect(created.identifier).toBe("OPS-42");
    expect(operations(fetchImpl)).toEqual([
      "ResponderLinearIssueLabel",
      "ResponderCreateLinearIssue",
    ]);
    const request = requestFor(fetchImpl, "ResponderCreateLinearIssue");
    expect(request.headers.authorization).toBe("Bearer linear-token");
    expect(JSON.parse(request.body)).toMatchObject({
      variables: {
        input: {
          id: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
          labelIds: ["responder-label"],
          projectId: "project-id",
          teamId: "team-id",
          title: issue.title,
        },
      },
    });
  });

  it("sends the assignee, labels, priority, state, and parent when given", async () => {
    const fetchImpl = linearApi({
      ResponderLinearIssueLabel: { issueLabels: { nodes: [workspaceLabel] } },
      ResponderCreateLinearIssue: createdIssue,
    });
    await createLinearIssue({
      accessToken: "linear-token",
      assigneeId: "user-id",
      description: "Rendered description",
      fetchImpl,
      id: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
      labelIds: ["label-id"],
      parentId: "parent-id",
      priority: 0,
      stateId: "state-id",
      teamId: "team-id",
      title: issue.title,
    });

    const request = requestFor(fetchImpl, "ResponderCreateLinearIssue");
    expect(JSON.parse(request.body).variables.input).toEqual({
      assigneeId: "user-id",
      description: "Rendered description",
      id: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
      labelIds: ["label-id", "responder-label"],
      parentId: "parent-id",
      priority: 0,
      stateId: "state-id",
      teamId: "team-id",
      title: issue.title,
    });
  });

  it("does not repeat the label when the agent already chose it", async () => {
    const fetchImpl = linearApi({
      ResponderLinearIssueLabel: { issueLabels: { nodes: [workspaceLabel] } },
      ResponderCreateLinearIssue: createdIssue,
    });

    await createLinearIssue({
      accessToken: "linear-token",
      description: "Rendered description",
      fetchImpl,
      id: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
      labelIds: ["responder-label"],
      teamId: "team-id",
      title: issue.title,
    });

    const request = requestFor(fetchImpl, "ResponderCreateLinearIssue");
    expect(JSON.parse(request.body).variables.input.labelIds).toEqual([
      "responder-label",
    ]);
  });

  it("creates the issue without the label when Linear refuses the label", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = linearApi({
      ResponderLinearIssueLabel: { issueLabels: { nodes: [] } },
      ResponderCreateLinearIssueLabel: new Error("Only admins can create labels"),
      ResponderCreateLinearIssue: createdIssue,
    });

    await expect(createLinearIssue({
      accessToken: "linear-token",
      description: "Rendered description",
      fetchImpl,
      id: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
      teamId: "team-id",
      title: issue.title,
    })).resolves.toMatchObject({ identifier: "OPS-42" });

    const request = requestFor(fetchImpl, "ResponderCreateLinearIssue");
    expect(JSON.parse(request.body).variables.input).not.toHaveProperty("labelIds");
    expect(errorLog).toHaveBeenCalledWith(
      "Unable to apply the Linear issue label: Only admins can create labels",
    );
  });

  it("finds an existing issue by the stable request ID before a retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        issue: {
          id: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
          identifier: "OPS-42",
          url: "https://linear.app/example/issue/OPS-42/checkout-returns-503",
        },
      },
    }), { status: 200 }));

    await expect(findLinearIssueById({
      accessToken: "linear-token",
      fetchImpl,
      issueId: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
    })).resolves.toMatchObject({ identifier: "OPS-42" });
  });

  it("rejects an executable issue URL before it can be persisted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        issue: {
          id: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
          identifier: "OPS-42",
          url: "javascript:alert(document.domain)",
        },
      },
    }), { status: 200 }));

    await expect(findLinearIssueById({
      accessToken: "linear-token",
      fetchImpl,
      issueId: "81e37ee3-e8cf-4806-82f1-ad81fcd24dbd",
    })).rejects.toThrow("Linear issue URLs must use HTTPS");
  });
});

describe("Linear issue label", () => {
  it("is named Responder unless the deployment renames it", () => {
    expect(linearIssueLabelName({})).toBe("Responder");
    expect(linearIssueLabelName({ LINEAR_ISSUE_LABEL: " Superlog " })).toBe("Superlog");
  });

  it("prefers the workspace label over a team label or label group", async () => {
    const fetchImpl = linearApi({
      ResponderLinearIssueLabel: {
        issueLabels: {
          nodes: [
            { id: "group", isGroup: true, team: null },
            { id: "team-label", isGroup: false, team: { id: "team-id" } },
            workspaceLabel,
          ],
        },
      },
    });

    await expect(ensureLinearIssueLabel({
      accessToken: "linear-token",
      fetchImpl,
      name: "Responder",
      teamId: "team-id",
    })).resolves.toBe("responder-label");
  });

  it("uses the team's own label when the workspace has none", async () => {
    const fetchImpl = linearApi({
      ResponderLinearIssueLabel: {
        issueLabels: {
          nodes: [
            { id: "other-team-label", isGroup: false, team: { id: "other-team" } },
            { id: "team-label", isGroup: false, team: { id: "team-id" } },
          ],
        },
      },
    });

    await expect(ensureLinearIssueLabel({
      accessToken: "linear-token",
      fetchImpl,
      name: "Responder",
      teamId: "team-id",
    })).resolves.toBe("team-label");
  });

  it("creates a workspace label on first use", async () => {
    const fetchImpl = linearApi({
      ResponderLinearIssueLabel: { issueLabels: { nodes: [] } },
      ResponderCreateLinearIssueLabel: {
        issueLabelCreate: { success: true, issueLabel: { id: "new-label" } },
      },
    });

    await expect(ensureLinearIssueLabel({
      accessToken: "linear-token",
      fetchImpl,
      name: "Superlog",
      teamId: "team-id",
    })).resolves.toBe("new-label");

    const request = requestFor(fetchImpl, "ResponderCreateLinearIssueLabel");
    expect(JSON.parse(request.body).variables.input).toEqual({
      color: "#6B6F76",
      name: "Superlog",
    });
    expect(JSON.parse(requestFor(fetchImpl, "ResponderLinearIssueLabel").body).variables)
      .toEqual({ name: "Superlog" });
  });

  it("uses the label a concurrent run created first", async () => {
    let lookups = 0;
    const fetchImpl = linearApi({
      ResponderLinearIssueLabel: () => ({
        issueLabels: { nodes: lookups++ === 0 ? [] : [workspaceLabel] },
      }),
      ResponderCreateLinearIssueLabel: new Error("Label already exists"),
    });

    await expect(ensureLinearIssueLabel({
      accessToken: "linear-token",
      fetchImpl,
      name: "Responder",
      teamId: "team-id",
    })).resolves.toBe("responder-label");
  });
});
