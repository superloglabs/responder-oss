import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  app,
  authHandlerErrorMessage,
  logAuthCallback,
  sessionCookieFingerprint,
} from "./app.js";
import {
  isResolvedSlackAlert,
  isSentryIssueAlert,
  isSlackErrorRecap,
  isSlackIssueResolutionMessage,
  investigatingSlackMessage,
  isSupportedSlackMessageSubtype,
  logAcceptedSlackAppAlert,
  logSlackAcknowledgementFailure,
  slackCopyPromptResponse,
  slackAlertProvider,
  slackMessageBody,
  slackPullRequestQueuedResponse,
  shouldIgnoreResolvedSlackAlert,
} from "./webhooks/slack.js";
import {
  sentryIssueBody,
  verifySentrySignature,
} from "./webhooks/sentry.js";
import { startSlackIssueRemediation } from "./issues/remediation.js";
import { queueInvestigation } from "./investigations/queue.js";

vi.mock("./issues/remediation.js", () => ({
  startIssueRemediation: vi.fn(),
  startSlackIssueRemediation: vi.fn(),
}));

vi.mock("./tenant.js", () => ({
  getActiveTenant: vi.fn().mockResolvedValue({
    ok: false,
    error: "Unauthorized",
    status: 401,
  }),
}));

vi.mock("./investigations/queue.js", () => ({
  closeInvestigationQueue: vi.fn(),
  queueInvestigation: vi.fn(),
}));

describe("control-plane API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("logs successful OAuth redirects as info and failures as errors", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logAuthCallback("github", 302, true);
    logAuthCallback("github", 400, false);

    expect(info).toHaveBeenCalledWith(
      JSON.stringify({
        event: "auth_callback",
        provider: "github",
        status: 302,
        setsSessionCookie: true,
      }),
    );
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "auth_callback",
        provider: "github",
        status: 400,
        setsSessionCookie: false,
      }),
    );
  });

  it("creates a stable, non-reversible session cookie fingerprint", () => {
    const cookie = "__Secure-responder-auth.session_token=secret-token.signature";
    const fingerprint = sessionCookieFingerprint(cookie);

    expect(fingerprint).toHaveLength(12);
    expect(fingerprint).toBe(sessionCookieFingerprint(cookie));
    expect(fingerprint).not.toContain("secret-token");
    expect(sessionCookieFingerprint("unrelated=value")).toBe("unknown");
  });

  it("classifies auth handler errors without logging raw messages", () => {
    expect(authHandlerErrorMessage(new Error("DATABASE_URL is required"))).toBe(
      "database_error",
    );
    expect(authHandlerErrorMessage(new Error("connection timed out"))).toBe(
      "timeout_error",
    );
    expect(authHandlerErrorMessage(new Error("request failed"))).toBe(
      "internal_error",
    );
  });

  it("reports a healthy service", async () => {
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "responder-control-plane",
      status: "ok",
    });
  });

  it("routes the GitHub App setup callback to the integration flow", async () => {
    const response = await app.request(
      "https://responder.example/api/auth/github/callback" +
        "?code=github-code" +
        "&installation_id=12345" +
        "&setup_action=install" +
        "&state=responder-v1.callback.nonce",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/api/integrations/github/callback" +
        "?code=github-code" +
        "&installation_id=12345" +
        "&setup_action=install" +
        "&state=responder-v1.callback.nonce",
    );
  });

  it("rejects unauthenticated investigation requests", async () => {
    const response = await app.request("/api/investigations", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(401);
  });

  it("rejects unauthenticated agent reads", async () => {
    const [listResponse, optionsResponse, issuesResponse] = await Promise.all([
      app.request("/api/agents"),
      app.request("/api/agents/options"),
      app.request("/api/issues"),
    ]);

    expect(listResponse.status).toBe(401);
    expect(optionsResponse.status).toBe(401);
    expect(issuesResponse.status).toBe(401);
  });

  it("rejects unauthenticated agent writes", async () => {
    const [createResponse, refreshResponse] = await Promise.all([
      app.request("/api/agents", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      app.request("/api/agents/options/refresh/slack", { method: "POST" }),
    ]);

    expect(createResponse.status).toBe(401);
    expect(refreshResponse.status).toBe(401);
  });

  it("rejects unauthenticated billing requests", async () => {
    const [summaryResponse, checkoutResponse] = await Promise.all([
      app.request("/api/billing"),
      app.request("/api/billing/checkout", { method: "POST" }),
    ]);

    expect(summaryResponse.status).toBe(401);
    expect(checkoutResponse.status).toBe(401);
  });

  it("answers signed Slack URL verification requests", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "slack-challenge",
    });
    const signature = `v0=${createHmac("sha256", "slack-signing-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;

    const response = await app.request("/api/webhooks/slack", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      challenge: "slack-challenge",
    });
  });

  it("rejects unsigned Slack webhook requests", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    const response = await app.request("/api/webhooks/slack", {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "nope" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(401);
  });

  it("verifies Sentry webhooks against the raw request body", () => {
    const rawBody = JSON.stringify({ action: "created", data: { issue: {} } });
    const signature = createHmac("sha256", "sentry-secret")
      .update(rawBody, "utf8")
      .digest("hex");

    expect(
      verifySentrySignature({
        rawBody,
        signature,
        clientSecret: "sentry-secret",
      }),
    ).toBe(true);
    expect(
      verifySentrySignature({
        rawBody: `${rawBody} `,
        signature,
        clientSecret: "sentry-secret",
      }),
    ).toBe(false);
  });

  it("rejects unsigned Sentry webhook requests", async () => {
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    const response = await app.request("/api/webhooks/sentry", {
      method: "POST",
      body: JSON.stringify({ action: "created" }),
      headers: {
        "content-type": "application/json",
        "sentry-hook-resource": "issue",
      },
    });

    expect(response.status).toBe(401);
  });

  it("normalizes useful Sentry issue context for an investigation", () => {
    const body = sentryIssueBody({
      id: "123",
      shortId: "EXAMPLE-1",
      title: "Cannot read properties of null",
      level: "error",
      project: {
        id: "456",
        name: "Example",
        slug: "example",
        platform: "javascript-nextjs",
      },
      issueCategory: "error",
      firstSeen: "2026-07-31T12:00:00Z",
    });

    expect(JSON.parse(body)).toMatchObject({
      shortId: "EXAMPLE-1",
      title: "Cannot read properties of null",
      project: { id: "456", slug: "example" },
      platform: "javascript-nextjs",
      issueCategory: "error",
    });
  });

  it("classifies known providers and generic app alerts", () => {
    expect(
      slackAlertProvider({
        body: "Triggered: Error logs",
        botAppId: "A-DATADOG",
        botId: "B-DATADOG",
        botName: "Datadog",
      }),
    ).toBe("datadog");
    expect(
      slackAlertProvider({
        body: "A new issue occurred",
        botAppId: "A-SENTRY",
        botId: "B-SENTRY",
        botName: "Sentry",
      }),
    ).toBe("sentry");
    expect(
      slackAlertProvider({
        body: "Look at https://app.datadoghq.eu/logs",
      }),
    ).toBeNull();
    expect(
      slackAlertProvider({
        body: "Look at https://sentry.io/organizations/example/issues/1",
        botAppId: "A-OTHER",
        botId: "B-OTHER",
        botName: "Release bot",
      }),
    ).toBeNull();
    expect(
      slackAlertProvider({
        body: "Triggered: <https://app.datadoghq.com/monitors/1|View>",
        botAppId: "A-NAMELESS",
        botId: "B-NAMELESS",
      }),
    ).toBe("datadog");
    expect(
      slackAlertProvider({
        body: "Alert: checkout latency is above the threshold",
        botAppId: "A-CLICKSTACK",
        botId: "B-CLICKSTACK",
        botName: "ClickStack",
      }),
    ).toBe("app");
    expect(
      slackAlertProvider({
        body: "Production alert needs another look",
        subtype: "thread_broadcast",
      }),
    ).toBe("app");
    expect(
      slackAlertProvider({
        body: "Alerting rules were updated",
        botAppId: "A-OTHER",
        botId: "B-OTHER",
        botName: "Release bot",
      }),
    ).toBeNull();
    expect(
      isResolvedSlackAlert(
        ':white_check_mark: Alert for "test" - 0 lines found',
      ),
    ).toBe(true);
    expect(isResolvedSlackAlert('✅ Alert for "test" - 0 lines found')).toBe(
      true,
    );
    expect(isResolvedSlackAlert('🚨 Alert for "test" - 1 line found')).toBe(
      false,
    );
  });

  it("accepts Sentry thread broadcasts as alert messages", () => {
    const event = {
      type: "message" as const,
      app_id: "A-SENTRY",
      bot_id: "B-SENTRY",
      channel: "C-INCIDENTS",
      ts: "1700000001.000001",
      thread_ts: "1700000000.000001",
      subtype: "thread_broadcast",
      text: "APP-44 ingest dropped event",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "<https://sentry.io/organizations/example/issues/44|APP-44>",
          },
        },
      ],
    };
    const body = slackMessageBody(event);

    expect(isSupportedSlackMessageSubtype(event.subtype)).toBe(true);
    expect(body).toContain("https://sentry.io/");
    expect(
      slackAlertProvider({
        body,
        botAppId: event.app_id,
        botId: event.bot_id,
      }),
    ).toBe("sentry");
    expect(isSupportedSlackMessageSubtype("channel_join")).toBe(false);
  });

  it.each([
    {
      name: "Datadog trigger",
      body: [
        "Triggered: Error logs",
        "More than 1 log event matched.",
        "<https://app.datadoghq.eu/logs?query=status%3Aerror|View in Log Explorer>",
      ].join("\n"),
      botName: "Datadog",
      expectedProvider: "datadog",
      subtype: undefined,
    },
    {
      name: "Sentry issue card from the screenshot",
      body: [
        "[demo] SyntaxError: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
        "POST /api/plants/marigold",
        "<https://demo.sentry.io/issues/140145603/|SyntaxError>",
        "Events: 3 First Seen: 2026-08-03",
      ].join("\n"),
      botName: "Sentry",
      expectedProvider: "sentry",
      subtype: undefined,
    },
    {
      name: "Sentry exception card",
      body: [
        "[example-tasks] NodeExecutionException: Image processing timed out. Please try again.",
        "<https://example.sentry.io/issues/140145604/|NodeExecutionException>",
      ].join("\n"),
      botName: "Sentry",
      expectedProvider: "sentry",
      subtype: undefined,
    },
    {
      name: "minimal Sentry test card",
      body: "[demo] Test Issue",
      botName: "Sentry",
      expectedProvider: "sentry",
      subtype: undefined,
    },
    {
      name: "Sentry issue thread broadcast",
      body: [
        "APP-44 ingest dropped event",
        "<https://sentry.io/organizations/example/issues/44|APP-44>",
      ].join("\n"),
      botName: undefined,
      expectedProvider: "sentry",
      subtype: "thread_broadcast",
    },
    {
      name: "generic self-hosted HyperDX alert",
      body: "Alert: checkout latency exceeded 2 seconds",
      botName: "HyperDX",
      expectedProvider: "app",
      subtype: undefined,
    },
  ])("accepts the observed $name shape", (shape) => {
    const provider = slackAlertProvider({
      body: shape.body,
      botAppId: shape.subtype ? undefined : "A-APP",
      botId: shape.subtype ? undefined : "B-BOT",
      botName: shape.botName,
      subtype: shape.subtype,
    });

    expect(provider).toBe(shape.expectedProvider);
    if (provider === "sentry") {
      expect(isSentryIssueAlert(shape.body, shape.subtype)).toBe(true);
    }
    if (provider) {
      expect(
        shouldIgnoreResolvedSlackAlert(provider, shape.body, shape.botName),
      ).toBe(false);
    }
  });

  it("ignores human messages in a watched channel", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event_id: "EvHuman",
      event: {
        type: "message",
        channel: "C123",
        ts: "1700000002.000001",
        user: "U123",
        text: "Can someone take a look at this?",
      },
    });
    const signature = `v0=${createHmac("sha256", "slack-signing-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;

    const response = await app.request("/api/webhooks/slack", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: true,
      reason: "unsupported_alert_sender",
    });
  });

  it("ignores resolved app alerts that start with a white check mark", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event_id: "EvResolved",
      event: {
        type: "message",
        bot_id: "B-CLICKSTACK",
        bot_profile: {
          app_id: "A-CLICKSTACK",
          name: "ClickStack",
        },
        channel: "C123",
        ts: "1700000002.000001",
        text: ':white_check_mark: Alert for "test" - 0 lines found',
      },
    });
    const signature = `v0=${createHmac("sha256", "slack-signing-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;

    const response = await app.request("/api/webhooks/slack", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: true,
      reason: "resolved_alert",
    });
    expect(queueInvestigation).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith(
      JSON.stringify({
        botAppId: "A-CLICKSTACK",
        botId: "B-CLICKSTACK",
        channelId: "C123",
        event: "slack_app_alert_ignored",
        eventId: "EvResolved",
        reason: "resolved_alert",
        teamId: "T123",
      }),
    );
  });

  it("ignores aggregate error recap app messages", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event_id: "EvErrorRecap",
      event: {
        type: "message",
        bot_id: "B-CLICKSTACK",
        bot_profile: {
          app_id: "A-CLICKSTACK",
          name: "ClickStack",
        },
        channel: "C123",
        ts: "1700000003.000001",
        text: [
          "*:bar_chart: Error recap · last 24h*",
          "78 events · 17 distinct error(s) · 19 alert(s) posted",
          "×47 checkout.payment.prepare.failed",
        ].join("\n"),
      },
    });
    const signature = `v0=${createHmac("sha256", "slack-signing-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;

    const response = await app.request("/api/webhooks/slack", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: true,
      reason: "error_recap",
    });
    expect(queueInvestigation).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith(
      JSON.stringify({
        botAppId: "A-CLICKSTACK",
        botId: "B-CLICKSTACK",
        channelId: "C123",
        event: "slack_app_alert_ignored",
        eventId: "EvErrorRecap",
        reason: "error_recap",
        teamId: "T123",
      }),
    );
  });

  it("ignores issue resolution notifications authored by Slack", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event_id: "EvIssueResolved",
      event: {
        type: "message",
        bot_id: "B-SLACK",
        bot_profile: {
          app_id: "A-SLACK",
          name: "Slack",
        },
        channel: "C123",
        ts: "1700000002.000001",
        text: [
          "DEMO-7 was resolved by operator@example.com",
          "DEMO-7 had its status changed to resolved.",
          'DatabaseError — POST /api/plants/deadlock-dahlia',
          'Project: demo · Alert: Notify #responder-test via Slack',
        ].join("\n"),
      },
    });
    const signature = `v0=${createHmac("sha256", "slack-signing-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;

    const response = await app.request("/api/webhooks/slack", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: true,
      reason: "resolved_alert",
    });
    expect(queueInvestigation).not.toHaveBeenCalled();
  });

  it("ignores Sentry issue activity notifications", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event_id: "EvSentryResolved",
      event: {
        type: "message",
        bot_id: "B-SENTRY",
        bot_profile: {
          app_id: "A-SENTRY",
          name: "Sentry",
        },
        channel: "C123",
        ts: "1700000002.000001",
        text: [
          "Example User marked <https://example.sentry.io/issues/140145603/|APP-FRONTEND-94> as resolved in an upcoming release",
          "Project: example-frontend",
        ].join("\n"),
      },
    });
    const signature = `v0=${createHmac("sha256", "slack-signing-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;

    const response = await app.request("/api/webhooks/slack", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: true,
      reason: "unsupported_sentry_message",
    });
    expect(queueInvestigation).not.toHaveBeenCalled();
  });

  it("applies the generic resolved-alert heuristic only to app alerts", () => {
    const body = "✅ Alert: error rate is above its threshold";

    expect(shouldIgnoreResolvedSlackAlert("app", body)).toBe(true);
    expect(shouldIgnoreResolvedSlackAlert("datadog", body)).toBe(false);
    expect(shouldIgnoreResolvedSlackAlert("sentry", body)).toBe(false);
  });

  it("recognizes error recap titles without hiding individual alerts", () => {
    expect(
      isSlackErrorRecap(
        "*:bar_chart: Error recap · last 24h*\n19 alert(s) posted",
      ),
    ).toBe(true);
    expect(isSlackErrorRecap("📊 Error recap - last 7 days")).toBe(true);
    expect(isSlackErrorRecap("Alert: error recap generation failed")).toBe(
      false,
    );
    expect(isSlackErrorRecap("Alert: checkout latency exceeded 2 seconds")).toBe(
      false,
    );
  });

  it("ignores Slack-authored issue resolution messages", () => {
    const body = [
      "DEMO-7 was resolved by operator@example.com",
      "DEMO-7 had its status changed to resolved.",
      'DatabaseError — POST /api/plants/deadlock-dahlia',
      'Project: demo · Alert: Notify #responder-test via Slack',
    ].join("\n");

    expect(isSlackIssueResolutionMessage(body)).toBe(true);
    expect(shouldIgnoreResolvedSlackAlert("app", body, "Slack")).toBe(true);
    expect(shouldIgnoreResolvedSlackAlert("app", body, "Other app")).toBe(
      false,
    );
    expect(shouldIgnoreResolvedSlackAlert("sentry", body, "Slack")).toBe(
      false,
    );
  });

  it.each([
    "Example User marked <https://example.sentry.io/issues/140145603/|APP-FRONTEND-94> as resolved",
    "Example User marked <https://example.sentry.io/issues/140145603/|APP-FRONTEND-94> as resolved in an upcoming release",
    "APP-FRONTEND-94 was resolved by user@example.com",
  ])("rejects the observed Sentry activity shape: %s", (body) => {
    expect(isSentryIssueAlert(body)).toBe(false);
  });

  it("logs accepted generic app alerts without message contents", () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    logAcceptedSlackAppAlert({
      botAppId: "A-CLICKSTACK",
      botId: "B-CLICKSTACK",
      channelId: "C123",
      eventId: "EvAlert",
      subtype: "thread_broadcast",
      teamId: "T123",
      timestamp: "1700000002.000001",
    });

    expect(infoLog).toHaveBeenCalledWith(
      JSON.stringify({
        botAppId: "A-CLICKSTACK",
        botId: "B-CLICKSTACK",
        channelId: "C123",
        eventId: "EvAlert",
        subtype: "thread_broadcast",
        teamId: "T123",
        timestamp: "1700000002.000001",
        event: "slack_app_alert_accepted",
      }),
    );
  });

  it("links the investigating acknowledgement to the live investigation", () => {
    vi.stubEnv("RESPONDER_APP_URL", "https://responder.example/");

    const message = investigatingSlackMessage({
      agentId: "a494280e-0ba6-43d7-9d83-25b28a9f9a37",
      investigationId: "153080dd-2a02-48a4-a433-78f27978e0d9",
      title: "Plant API error rate is elevated",
    });

    expect(message.text).toContain("Plant API error rate is elevated");
    expect(message.blocks).toContainEqual(
      expect.objectContaining({
        type: "plan",
        title: "Plant API error rate is elevated",
        tasks: [
          expect.objectContaining({
            status: "in_progress",
            sources: [
              {
                type: "url",
                text: "View investigation",
                url: "https://responder.example/agents/a494280e-0ba6-43d7-9d83-25b28a9f9a37/investigations/153080dd-2a02-48a4-a433-78f27978e0d9",
              },
            ],
          }),
        ],
      }),
    );
  });

  it("logs Slack acknowledgement failures with alert context", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    logSlackAcknowledgementFailure({
      alertProvider: "app",
      error: new Error("Slack returned HTTP 503"),
      investigationId: "153080dd-2a02-48a4-a433-78f27978e0d9",
    });

    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        alertProvider: "app",
        error: "Slack returned HTTP 503",
        event: "slack_alert_acknowledgement_failed",
        investigationId: "153080dd-2a02-48a4-a433-78f27978e0d9",
      }),
    );
  });

  it("logs each failed Slack acknowledgement operation", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    logSlackAcknowledgementFailure({
      alertProvider: "app",
      error: new AggregateError(
        [new Error("reactions.add: not_allowed"), "chat.postMessage: timeout"],
        "Unable to fully acknowledge the Slack alert",
      ),
      investigationId: "153080dd-2a02-48a4-a433-78f27978e0d9",
    });

    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        alertProvider: "app",
        error: "Unable to fully acknowledge the Slack alert",
        errors: [
          "reactions.add: not_allowed",
          "chat.postMessage: timeout",
        ],
        event: "slack_alert_acknowledgement_failed",
        investigationId: "153080dd-2a02-48a4-a433-78f27978e0d9",
      }),
    );
  });

  it("renders issue prompts in Slack's native markdown code block", () => {
    expect(slackCopyPromptResponse("Fix the checkout route.")).toEqual({
      response_type: "ephemeral",
      replace_original: false,
      text: "Here is the prompt containing the investigation context:",
      blocks: [
        {
          type: "markdown",
          text: "Here is the prompt containing the investigation context:\n\n```markdown\nFix the checkout route.\n```",
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "dismiss_copy_prompt",
              text: { type: "plain_text", text: "Dismiss" },
            },
          ],
        },
      ],
    });
  });

  it("removes the create-pull-request button after queueing", () => {
    expect(
      slackPullRequestQueuedResponse({
        text: "SEV-2 — Plant API returns HTTP 500",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "*SEV-2 — Plant API*" },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "create_issue_pull_request",
                value: "50124a45-ab04-4e85-aec9-836c1b4f9ad0",
              },
              {
                type: "button",
                action_id: "view_issue",
                value: "50124a45-ab04-4e85-aec9-836c1b4f9ad0",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      replace_original: true,
      text: "SEV-2 — Plant API returns HTTP 500",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*SEV-2 — Plant API*" },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "view_issue",
              value: "50124a45-ab04-4e85-aec9-836c1b4f9ad0",
            },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "Pull request creation started. Follow progress in the issue.",
            },
          ],
        },
      ],
    });
  });

  it("starts pull request creation from a signed Slack action", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    vi.mocked(startSlackIssueRemediation).mockResolvedValue({
      ok: true,
      requestId: "f7745ad3-97bf-4682-a451-f3bb84d25c94",
      sessionId: "session-1",
    });
    const responseUrl =
      "https://hooks.slack.com/actions/T123/B123/response-token";
    const issueId = "50124a45-ab04-4e85-aec9-836c1b4f9ad0";
    const payload = JSON.stringify({
      type: "block_actions",
      team: { id: "T123" },
      channel: { id: "C123" },
      user: { id: "U123" },
      response_url: responseUrl,
      message: {
        text: "SEV-2 — Plant API returns HTTP 500",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "create_issue_pull_request",
                value: issueId,
              },
            ],
          },
        ],
      },
      actions: [
        {
          action_id: "create_issue_pull_request",
          value: issueId,
        },
      ],
    });
    const body = new URLSearchParams({ payload }).toString();
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = `v0=${createHmac("sha256", "slack-signing-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/webhooks/slack/actions", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    expect(startSlackIssueRemediation).toHaveBeenCalledWith({
      issueId,
      teamId: "T123",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      responseUrl,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("dismisses an ephemeral Slack issue prompt", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    const responseUrl =
      "https://hooks.slack.com/actions/T123/B123/response-token";
    const payload = JSON.stringify({
      type: "block_actions",
      team: { id: "T123" },
      channel: { id: "C123" },
      user: { id: "U123" },
      response_url: responseUrl,
      actions: [{ action_id: "dismiss_copy_prompt" }],
    });
    const body = new URLSearchParams({ payload }).toString();
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = `v0=${createHmac("sha256", "slack-signing-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/webhooks/slack/actions", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete_original: true }),
    });
  });

  it("acknowledges Datadog recovery messages without starting an investigation", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "slack-signing-secret");
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event_id: "EvRecovery",
      event: {
        type: "message",
        bot_id: "B-DATADOG",
        bot_profile: {
          app_id: "A-DATADOG",
          name: "Datadog",
        },
        channel: "C123",
        ts: "1700000004.000001",
        text: "",
        attachments: [
          {
            title: "Recovered: Error logs",
            text: "Less than 1 log event matched. <https://app.datadoghq.eu/logs?query=status%3Aerror|View in Log Explorer>",
          },
        ],
      },
    });
    const signature = `v0=${createHmac("sha256", "slack-signing-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;

    const response = await app.request("/api/webhooks/slack", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: true,
      reason: "datadog_recovery",
    });
  });

  it("adds valid investigations to the worker queue", async () => {
    vi.stubEnv("INTERNAL_INGEST_TOKEN", "test-secret");
    vi.mocked(queueInvestigation).mockResolvedValue({
      kind: "queued",
      investigationId: "153080dd-2a02-48a4-a433-78f27978e0d9",
      jobId: "e9c7b0b1-1f28-448f-b5a7-0cb240ae41e4",
    });

    const response = await app.request("/api/investigations", {
      method: "POST",
      body: JSON.stringify({
        agentId: "a494280e-0ba6-43d7-9d83-25b28a9f9a37",
        provider: "sentry",
        externalEventId: "event-1",
        title: "Production error",
        body: "The API is returning HTTP 500.",
      }),
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      duplicate: false,
      investigationId: "153080dd-2a02-48a4-a433-78f27978e0d9",
      jobId: "e9c7b0b1-1f28-448f-b5a7-0cb240ae41e4",
    });
    expect(queueInvestigation).toHaveBeenCalledWith({
      agentId: "a494280e-0ba6-43d7-9d83-25b28a9f9a37",
      provider: "sentry",
      externalEventId: "event-1",
      title: "Production error",
      body: "The API is returning HTTP 500.",
    });
  });
});
