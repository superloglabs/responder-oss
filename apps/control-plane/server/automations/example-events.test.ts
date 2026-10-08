import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationTrigger } from "../../../../packages/core/src/automations/config.js";
import { encryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  AutomationExampleError,
  exampleAutomationTrigger,
  listAutomationExampleEvents,
  type ExampleEventDependencies,
} from "./example-events.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const slackAccountId = "41414141-4141-4141-8141-414141414141";
const sentryAccountId = "51515151-5151-4151-8151-515151515151";
const installationId = "61616161-6161-4161-8161-616161616161";

const slackTrigger: AutomationTrigger = {
  channelIds: ["C1"],
  eventMode: "every_message",
  ignoredAuthors: [{ id: "A_IGNORED", name: "Noisy bot" }],
  integrationAccountId: slackAccountId,
  kind: "slack",
};
const sentryTrigger: AutomationTrigger = {
  eventTypes: ["new_issue"],
  integrationAccountId: sentryAccountId,
  kind: "sentry",
  projectIds: ["7"],
};

const issue = {
  firstSeen: "2026-10-01T10:00:00Z",
  id: "42",
  lastSeen: "2026-10-07T10:00:00Z",
  level: "error",
  permalink: "https://acme.sentry.io/issues/42/",
  project: { id: "7", name: "Checkout", slug: "checkout" },
  shortId: "CHECKOUT-1",
  title: "TypeError: cart is undefined",
};

function dependencies(overrides: Partial<ExampleEventDependencies> = {}): ExampleEventDependencies {
  return {
    getAccount: vi.fn(async ({ provider }) => provider === "slack"
      ? {
          encryptedCredentials: encryptCredentials({ accessToken: "xoxb-bot" }),
          externalAccountId: "T1",
          metadata: { appId: "A_RESPONDER", botUserId: "U_RESPONDER" },
        }
      : { encryptedCredentials: null, externalAccountId: installationId, metadata: { organizationSlug: "acme" } }),
    getEnvironment: vi.fn().mockResolvedValue("production"),
    getResourceNames: vi.fn().mockResolvedValue(new Map([["C1", "alerts"]])),
    getSentryCredentials: vi.fn().mockResolvedValue({
      credentials: { accessToken: "sentry-token", installationId, refreshToken: "refresh" },
    }),
    getSentryIssue: vi.fn().mockResolvedValue(issue),
    listSentryIssues: vi.fn().mockResolvedValue([issue, { ...issue, id: "43", project: { id: "8" } }]),
    listSlackAuthors: vi.fn().mockResolvedValue([{ id: "U_PERSON", kind: "person", name: "Dana" }]),
    readSlackMessages: vi.fn().mockResolvedValue([
      { text: "Checkout is down\nsince 10:02", ts: "1759917600.000100", user: "U_PERSON" },
      { text: "I'm on it", ts: "1759917500.000100", user: "U_RESPONDER" },
      { bot_id: "B1", bot_profile: { app_id: "A_IGNORED", name: "Noisy bot" }, text: "Heartbeat", ts: "1759917400.000100" },
      { subtype: "channel_join", text: "<@U2> joined", ts: "1759917300.000100", user: "U2" },
    ]),
    ...overrides,
  } as ExampleEventDependencies;
}

describe("automation example events", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
  });

  it("lists the past messages and issues the triggers would have started a run on, newest first", async () => {
    const deps = dependencies();

    const examples = await listAutomationExampleEvents(organizationId, [slackTrigger, sentryTrigger], deps);

    expect(examples).toEqual([
      {
        integrationAccountId: sentryAccountId,
        issueId: "42",
        kind: "sentry",
        level: "error",
        occurredAt: "2026-10-07T10:00:00Z",
        projectName: "Checkout",
        shortId: "CHECKOUT-1",
        title: "TypeError: cart is undefined",
      },
      {
        authorName: "Dana",
        channelId: "C1",
        channelName: "alerts",
        integrationAccountId: slackAccountId,
        kind: "slack",
        occurredAt: "2025-10-08T10:00:00.000Z",
        timestamp: "1759917600.000100",
        title: "Checkout is down",
      },
    ]);
    expect(deps.readSlackMessages).toHaveBeenCalledWith({ accessToken: "xoxb-bot", channelId: "C1", limit: 20 });
    expect(deps.listSentryIssues).toHaveBeenCalledWith({
      accessToken: "sentry-token",
      limit: 20,
      organizationSlug: "acme",
      projectIds: ["7"],
    });
  });

  it("keeps the events of triggers it can read when another provider fails", async () => {
    const deps = dependencies({ listSentryIssues: vi.fn().mockRejectedValue(new Error("Sentry is down")) });

    const examples = await listAutomationExampleEvents(organizationId, [slackTrigger, sentryTrigger], deps);

    expect(examples.map((example) => example.kind)).toEqual(["slack"]);
    await expect(listAutomationExampleEvents(organizationId, [sentryTrigger], deps))
      .rejects.toBeInstanceOf(AutomationExampleError);
  });

  it("replays a past Slack message with the trigger a live run would get, marked as an example", async () => {
    const deps = dependencies({
      readSlackMessages: vi.fn().mockResolvedValue([
        { text: "<@U_RESPONDER> checkout is down", ts: "1759917600.000100", user: "U_PERSON", user_profile: { real_name: "Dana Ruiz" } },
      ]),
    });

    const trigger = await exampleAutomationTrigger(organizationId, [slackTrigger], {
      channelId: "C1",
      integrationAccountId: slackAccountId,
      kind: "slack",
      timestamp: "1759917600.000100",
    }, deps);

    expect(deps.readSlackMessages).toHaveBeenCalledWith({
      accessToken: "xoxb-bot",
      channelId: "C1",
      limit: 1,
      timestamp: "1759917600.000100",
    });
    expect(trigger).toEqual({
      attributes: {
        authorId: "U_PERSON",
        authorName: "Dana Ruiz",
        authorType: "person",
        channelId: "C1",
        example: true,
        mentioned: true,
        teamId: "T1",
        threadTimestamp: "1759917600.000100",
        timestamp: "1759917600.000100",
      },
      body: "<@U_RESPONDER> checkout is down",
      externalEventId: expect.stringMatching(/^example:/u),
      provider: "slack",
      sourceUrl: "https://slack.com/archives/C1/p1759917600000100",
      title: "<@U_RESPONDER> checkout is down",
    });
  });

  it("refuses to replay a message outside the triggers or one the trigger ignores", async () => {
    const deps = dependencies();
    const replay = (channelId: string, timestamp: string) => exampleAutomationTrigger(organizationId, [slackTrigger], {
      channelId,
      integrationAccountId: slackAccountId,
      kind: "slack",
      timestamp,
    }, deps);

    await expect(replay("C2", "1759917600.000100")).rejects.toMatchObject({ status: 404 });
    vi.mocked(deps.readSlackMessages).mockResolvedValue([
      { bot_profile: { app_id: "A_IGNORED" }, bot_id: "B1", text: "Heartbeat", ts: "1759917400.000100" },
    ]);
    await expect(replay("C1", "1759917400.000100")).rejects.toMatchObject({ message: "Slack message not found", status: 404 });
  });

  it("replays a past Sentry issue as a new issue in its project", async () => {
    const deps = dependencies();

    const trigger = await exampleAutomationTrigger(organizationId, [sentryTrigger], {
      integrationAccountId: sentryAccountId,
      issueId: "42",
      kind: "sentry",
    }, deps);

    expect(deps.getSentryIssue).toHaveBeenCalledWith({ accessToken: "sentry-token", issueId: "42", organizationSlug: "acme" });
    // The trigger excludes no environments, so a live run would not read one.
    expect(deps.getEnvironment).not.toHaveBeenCalled();
    expect(trigger).toMatchObject({
      attributes: {
        action: "created",
        example: true,
        installationId,
        issueId: "42",
        projectId: "7",
        projectName: "Checkout",
        projectSlug: "checkout",
      },
      externalEventId: expect.stringMatching(/^example:/u),
      provider: "sentry",
      sourceUrl: "https://acme.sentry.io/issues/42/",
      title: "CHECKOUT-1: TypeError: cart is undefined",
    });
    expect(JSON.parse(trigger.body)).toMatchObject({ shortId: "CHECKOUT-1", title: "TypeError: cart is undefined" });
  });

  it("reads the environment and refuses issues from other projects like a live run", async () => {
    const deps = dependencies();
    const regressions: AutomationTrigger = { ...sentryTrigger, eventTypes: ["regression"], excludedEnvironments: ["staging"] };
    const replay = () => exampleAutomationTrigger(organizationId, [regressions], {
      integrationAccountId: sentryAccountId,
      issueId: "42",
      kind: "sentry",
    }, deps);

    const trigger = await replay();
    expect(trigger.attributes).toMatchObject({ action: "unresolved", environment: "production" });
    expect(deps.getEnvironment).toHaveBeenCalledWith(expect.objectContaining({ event: "latest", issueId: "42" }));

    vi.mocked(deps.getSentryIssue).mockResolvedValue({ ...issue, project: { id: "8" } });
    await expect(replay()).rejects.toMatchObject({ message: "Sentry issue not found", status: 404 });
  });
});
