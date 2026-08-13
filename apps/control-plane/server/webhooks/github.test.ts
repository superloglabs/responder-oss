import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import { markIssuePullRequestMerged } from "@responder/core/db/pull-requests";
import { githubWebhookRoutes, verifyGitHubSignature } from "./github.js";

vi.mock("@responder/core/analytics", () => ({
  captureAnalyticsEvent: vi.fn(),
}));

vi.mock("@responder/core/db/pull-requests", () => ({
  markIssuePullRequestMerged: vi.fn(),
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

  it("does not capture an event when no matching pull request exists", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
    vi.mocked(markIssuePullRequestMerged).mockResolvedValue(null);

    const response = await post(pullRequestEvent());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, matched: false });
    expect(captureAnalyticsEvent).not.toHaveBeenCalled();
  });
});
