import { describe, expect, it, vi } from "vitest";
import {
  fetchSentryIssueTriageContext,
  sentryIssueLocator,
} from "./sentry-issue-context.js";

describe("Sentry issue triage context", () => {
  it("extracts issue IDs and selects the regional API origin", () => {
    expect(
      sentryIssueLocator(
        "<https://de.sentry.io/organizations/example/issues/140145603/|APP-42>",
      ),
    ).toEqual({
      apiBaseUrl: "https://de.sentry.io",
      issueId: "140145603",
    });
    expect(
      sentryIssueLocator(
        "<https://example.sentry.io/issues/140145604/|NodeExecutionException>",
      ),
    ).toEqual({
      apiBaseUrl: "https://sentry.io",
      issueId: "140145604",
    });
    expect(sentryIssueLocator("No issue URL here")).toBeNull();
    expect(
      sentryIssueLocator(
        "See https://example.sentry.io/issues/140145605/.,",
      ),
    ).toEqual({
      apiBaseUrl: "https://sentry.io",
      issueId: "140145605",
    });
  });

  it("fetches the connected organization's issue and returns bounded fields", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({
      count: "123",
      culprit: "checkout in submitOrder",
      firstSeen: "2026-09-20T10:00:00Z",
      id: "140145603",
      isUnhandled: true,
      lastSeen: "2026-09-22T10:00:00Z",
      latestEvent: {
        eventID: "event-1",
        message: "x".repeat(3_000),
        title: "Checkout failed",
      },
      level: "error",
      priority: "high",
      project: { id: "123", name: "Storefront", slug: "storefront" },
      shortId: "SHOP-42",
      status: "unresolved",
      title: "Checkout failed",
      userCount: 42,
    }));

    const result = await fetchSentryIssueTriageContext(
      {
        alertBody:
          "<https://us.sentry.io/organizations/acme/issues/140145603/|SHOP-42>",
        connection: {
          accessToken: "sentry-token",
          mcpUrl: "https://mcp.sentry.dev/acme",
          organizationSlug: "acme",
        },
      },
      request,
    );

    expect(String(request.mock.calls[0]![0])).toBe(
      "https://us.sentry.io/api/0/organizations/acme/issues/140145603/",
    );
    expect(request.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        headers: {
          accept: "application/json",
          authorization: "Bearer sentry-token",
        },
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      count: "123",
      id: "140145603",
      isUnhandled: true,
      priority: "high",
      project: { id: "123", name: "Storefront", slug: "storefront" },
      shortId: "SHOP-42",
      status: "unresolved",
      userCount: 42,
    }));
    expect(result?.latestEvent?.message).toHaveLength(2_000);
  });

  it("returns no enrichment without a supported issue URL", async () => {
    const request = vi.fn();

    await expect(
      fetchSentryIssueTriageContext(
        {
          alertBody: "[demo] Test issue",
          connection: {
            accessToken: "sentry-token",
            mcpUrl: "https://mcp.sentry.dev/example",
            organizationSlug: "example",
          },
        },
        request,
      ),
    ).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("returns no enrichment for an unexpected Sentry response", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({
      id: "140145603",
      latestEvent: { message: { unexpected: true } },
      permalink: null,
    }));

    await expect(
      fetchSentryIssueTriageContext(
        {
          alertBody: "https://example.sentry.io/issues/140145603/",
          connection: {
            accessToken: "sentry-token",
            mcpUrl: "https://mcp.sentry.dev/example",
            organizationSlug: "example",
          },
        },
        request,
      ),
    ).resolves.toBeNull();
  });
});
