import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import { markIssuePullRequestMerged } from "@responder/core/db/pull-requests";
import { markSuggestionPullRequestMerged } from "@responder/core/db/suggestion-pull-requests";
import { refreshIssuePullRequestSlackMessages } from "@responder/core/integrations/slack-remediations";
import { githubWebhookRoutes, verifyGitHubSignature } from "./github.js";
import { startPullRequestReviewTurn } from "./github-reviews.js";

vi.mock("@responder/core/analytics", () => ({
  captureAnalyticsEvent: vi.fn(),
}));

vi.mock("@responder/core/db/pull-requests", () => ({
  markIssuePullRequestMerged: vi.fn(),
}));

vi.mock("@responder/core/db/suggestion-pull-requests", () => ({
  markSuggestionPullRequestMerged: vi.fn(),
}));

vi.mock("@responder/core/integrations/slack-remediations", () => ({
  refreshIssuePullRequestSlackMessages: vi.fn(),
}));

vi.mock("./github-reviews.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./github-reviews.js")>(),
  startPullRequestReviewTurn: vi.fn(),
}));

const app = new Hono().route("/api/webhooks/github", githubWebhookRoutes);

function pullRequestEvent(overrides: {
  action?: string;
  merged?: boolean;
  number?: number;
  repository?: string;
} = {}) {
  return JSON.stringify({
    action: overrides.action ?? "closed",
    pull_request: {
      number: overrides.number ?? 42,
      merged: overrides.merged ?? true,
      html_url: "https://github.com/acme/api/pull/42",
    },
    repository: { full_name: overrides.repository ?? "acme/api" },
  });
}

function reviewEvent() {
  return JSON.stringify({
    action: "submitted",
    installation: { id: 789 },
    pull_request: { html_url: "https://github.com/acme/api/pull/42", number: 42 },
    repository: { full_name: "acme/api" },
    review: {
      author_association: "NONE",
      body: "",
      html_url: "https://github.com/acme/api/pull/42#pullrequestreview-5",
      id: 5,
      state: "commented",
      user: { login: "greptile-apps[bot]", type: "Bot" },
    },
  });
}

function sign(body: string, secret = "webhook-secret"): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function post(body: string, headers: Record<string, string> = {}) {
  return app.request("/api/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(body),
      ...headers,
    },
  });
}

describe("GitHub pull request webhooks", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("verifies the sha256 HMAC signature", () => {
    const rawBody = pullRequestEvent();
    expect(
      verifyGitHubSignature({
        rawBody,
        signature: sign(rawBody),
        webhookSecret: "webhook-secret",
      }),
    ).toBe(true);
    expect(
      verifyGitHubSignature({
        rawBody,
        signature: sign(rawBody, "wrong-secret"),
        webhookSecret: "webhook-secret",
      }),
    ).toBe(false);
  });

  it("rejects a request with an invalid signature", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
    const body = pullRequestEvent();

    const response = await app.request("/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=deadbeef",
      },
    });

    expect(response.status).toBe(401);
    expect(markIssuePullRequestMerged).not.toHaveBeenCalled();
  });

  it("captures a pr merged event for a known merged pull request", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
    vi.mocked(markIssuePullRequestMerged).mockResolvedValue({
      requestId: "req-1",
      organizationId: "10000000-0000-4000-8000-000000000000",
      issueId: "issue-1",
      investigationId: "inv-1",
      agentConfigVersionId: "cfg-1",
      pullRequestUrl: "https://github.com/acme/api/pull/42",
    });

    const response = await post(pullRequestEvent());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, matched: true });
    expect(markIssuePullRequestMerged).toHaveBeenCalledWith({
      repositoryFullName: "acme/api",
      pullRequestNumber: 42,
    });
    expect(markSuggestionPullRequestMerged).not.toHaveBeenCalled();
    expect(refreshIssuePullRequestSlackMessages).toHaveBeenCalledWith("req-1");
    expect(captureAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "pr merged",
        organizationId: "10000000-0000-4000-8000-000000000000",
        properties: expect.objectContaining({
          issue_id: "issue-1",
          investigation_id: "inv-1",
          pr_number: 42,
          pr_url: "https://github.com/acme/api/pull/42",
          repository: "acme/api",
        }),
      }),
    );
  });

  it("captures a pr merged event for a suggestion pull request", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
    vi.mocked(markIssuePullRequestMerged).mockResolvedValue(null);
    vi.mocked(markSuggestionPullRequestMerged).mockResolvedValue({
      requestId: "req-2",
      organizationId: "10000000-0000-4000-8000-000000000000",
      suggestionId: "suggestion-1",
      investigationId: "inv-1",
      agentConfigVersionId: "cfg-1",
      pullRequestUrl: "https://github.com/acme/api/pull/42",
    });

    const response = await post(pullRequestEvent());

    await expect(response.json()).resolves.toEqual({ ok: true, matched: true });
    expect(markSuggestionPullRequestMerged).toHaveBeenCalledWith({
      repositoryFullName: "acme/api",
      pullRequestNumber: 42,
    });
    expect(refreshIssuePullRequestSlackMessages).not.toHaveBeenCalled();
    expect(captureAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "pr merged",
        properties: expect.objectContaining({
          suggestion_id: "suggestion-1",
        }),
      }),
    );
  });

  it("ignores a pull request that was closed without merging", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");

    const response = await post(pullRequestEvent({ merged: false }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(markIssuePullRequestMerged).not.toHaveBeenCalled();
    expect(captureAnalyticsEvent).not.toHaveBeenCalled();
  });

  it("ignores events other than pull_request", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");

    const response = await post(pullRequestEvent(), { "x-github-event": "push" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(markIssuePullRequestMerged).not.toHaveBeenCalled();
  });

  it("continues the run or thread that opened a reviewed pull request", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
    vi.mocked(startPullRequestReviewTurn).mockResolvedValue("queued");

    const response = await post(reviewEvent(), { "x-github-event": "pull_request_review" });

    await expect(response.json()).resolves.toEqual({ ok: true, outcome: "queued" });
    expect(startPullRequestReviewTurn).toHaveBeenCalledWith(expect.objectContaining({
      action: "submitted",
      pull_request: expect.objectContaining({ number: 42 }),
      review: expect.objectContaining({ id: 5 }),
    }));
  });

  it("ignores a malformed review event", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");

    const response = await post(JSON.stringify({ action: "submitted" }), {
      "x-github-event": "pull_request_review",
    });

    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(startPullRequestReviewTurn).not.toHaveBeenCalled();
  });

  it("does not capture an event when no matching pull request exists", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
    vi.mocked(markIssuePullRequestMerged).mockResolvedValue(null);
    vi.mocked(markSuggestionPullRequestMerged).mockResolvedValue(null);

    const response = await post(pullRequestEvent());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, matched: false });
    expect(captureAnalyticsEvent).not.toHaveBeenCalled();
  });
});
