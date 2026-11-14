import { describe, expect, it, vi } from "vitest";
import {
  connectSlackWorkspace,
  SlackApiError,
  slackConnectChannelName,
  slackConnectConfig,
  type SlackCall,
  type SlackConnectDeps,
  type SlackConnectInstallation,
} from "./slack-connect.js";
import type { SlackConnectChannel } from "../db/slack-connect-channels.js";

const input = {
  integrationAccountId: "30000000-0000-4000-8000-000000000000",
  organizationId: "10000000-0000-4000-8000-000000000000",
  slackUserId: "U_MEMBER",
  userId: "user-1",
};

const fullInstallation: SlackConnectInstallation = {
  accessToken: "xoxb-customer",
  botUserId: "U_BOT",
  scopes: ["chat:write", "channels:write.invites", "conversations.connect:write"],
};

type Row = Pick<SlackConnectChannel, "channelId" | "channelName" | "lastError" | "status">;
type Responses = Record<string, Array<Record<string, unknown> | string>>;

// Answers each "<token> <method>" with the next queued response; a string is
// a Slack error code.
function harness(options: {
  installation?: SlackConnectInstallation | null;
  responses?: Responses;
  row?: Partial<Row>;
} = {}) {
  const row: Row = {
    channelId: null,
    channelName: null,
    lastError: null,
    status: "pending",
    ...options.row,
  };
  const responses: Responses = {
    "xoxb-host conversations.create": [{ channel: { id: "C1", name: "acme-superlog" } }],
    "xoxb-host conversations.invite": [{}],
    "xoxb-host conversations.inviteShared": [{ invite_id: "I1" }],
    "xoxb-customer conversations.acceptSharedInvite": [{ channel_id: "C1" }],
    "xoxb-customer conversations.invite": [{}],
    ...options.responses,
  };
  const call = vi.fn<SlackCall>(async (token, method) => {
    const queue = responses[`${token} ${method}`];
    const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (next === undefined) throw new Error(`unexpected ${token} ${method}`);
    if (typeof next === "string") throw new SlackApiError(method, next);
    return { ok: true, ...next };
  });
  const log = vi.fn();
  const deps: SlackConnectDeps = {
    call,
    claim: async () => ({ ...row }),
    config: { hostToken: "xoxb-host", hostUserIds: ["U_OPS1", "U_OPS2"] },
    installation: async () =>
      options.installation === undefined ? fullInstallation : options.installation,
    log,
    organizationName: async () => "Acme Inc.",
    update: async (_organizationId, patch) => {
      Object.assign(row, patch);
    },
    userEmail: async () => "member@acme.example",
  };
  const calls = () => call.mock.calls.map(([token, method, body]) => ({ body, method, token }));
  return { calls, deps, log, row };
}

describe("slackConnectChannelName", () => {
  it("makes a Slack channel name from the workspace name", () => {
    expect(slackConnectChannelName("Acme Inc.")).toBe("acme-inc-superlog");
    expect(slackConnectChannelName("Café Ünïcode")).toBe("cafe-unicode-superlog");
    expect(slackConnectChannelName("🚀")).toBe("workspace-superlog");
    expect(slackConnectChannelName("Acme", 2)).toBe("acme-superlog-3");
  });

  it("keeps names within Slack's 80 characters", () => {
    const name = slackConnectChannelName("a".repeat(200), 9);
    expect(name).toHaveLength(80);
    expect(name.endsWith("-superlog-10")).toBe(true);
  });
});

describe("slackConnectConfig", () => {
  it("is off without a host token", () => {
    expect(slackConnectConfig({})).toBeNull();
    expect(slackConnectConfig({ SLACK_CONNECT_HOST_TOKEN: " " })).toBeNull();
  });

  it("reads the operator members", () => {
    expect(
      slackConnectConfig({
        SLACK_CONNECT_HOST_TOKEN: "xoxb-host",
        SLACK_CONNECT_HOST_USER_IDS: "U1, U2,,",
      }),
    ).toEqual({ hostToken: "xoxb-host", hostUserIds: ["U1", "U2"] });
  });
});

describe("connectSlackWorkspace", () => {
  it("does nothing when the operator's Slack is not set up", async () => {
    const { calls, deps } = harness();
    await expect(connectSlackWorkspace(input, { ...deps, config: null })).resolves.toBe(
      "disabled",
    );
    expect(calls()).toEqual([]);
  });

  it("shares the channel with the workspace's app and adds the member", async () => {
    const { calls, deps, row } = harness();

    await expect(connectSlackWorkspace(input, deps)).resolves.toBe("joined");

    expect(calls()).toEqual([
      {
        body: { is_private: "false", name: "acme-inc-superlog" },
        method: "conversations.create",
        token: "xoxb-host",
      },
      {
        body: { channel: "C1", force: "true", users: "U_OPS1,U_OPS2" },
        method: "conversations.invite",
        token: "xoxb-host",
      },
      {
        body: { channel: "C1", external_limited: "false", user_ids: "U_BOT" },
        method: "conversations.inviteShared",
        token: "xoxb-host",
      },
      {
        body: { channel_name: "acme-superlog", invite_id: "I1" },
        method: "conversations.acceptSharedInvite",
        token: "xoxb-customer",
      },
      {
        body: { channel: "C1", users: "U_MEMBER" },
        method: "conversations.invite",
        token: "xoxb-customer",
      },
    ]);
    expect(row).toMatchObject({ channelId: "C1", status: "joined" });
  });

  it("emails the member when the workspace's app lacks the Slack Connect scopes", async () => {
    const { calls, deps, row } = harness({
      installation: { ...fullInstallation, scopes: ["chat:write"] },
    });

    await expect(connectSlackWorkspace(input, deps)).resolves.toBe("invited");

    expect(calls().filter((call) => call.token === "xoxb-customer")).toEqual([]);
    expect(calls().at(-1)).toEqual({
      body: { channel: "C1", emails: "member@acme.example", external_limited: "false" },
      method: "conversations.inviteShared",
      token: "xoxb-host",
    });
    expect(row.status).toBe("invited");
  });

  it("emails the member when the workspace's app can't accept", async () => {
    const { calls, deps, log, row } = harness({
      responses: {
        "xoxb-customer conversations.acceptSharedInvite": ["not_paid"],
        "xoxb-host conversations.inviteShared": [{ invite_id: "I1" }, {}],
      },
    });

    await expect(connectSlackWorkspace(input, deps)).resolves.toBe("invited");

    expect(log).toHaveBeenCalledWith("slack_connect_app_share_failed", {
      error: "Slack conversations.acceptSharedInvite failed: not_paid",
      organizationId: input.organizationId,
    });
    expect(calls().at(-1)?.body).toMatchObject({ emails: "member@acme.example" });
    expect(row.status).toBe("invited");
  });

  it("tries the next channel name when one is taken", async () => {
    const { calls, deps } = harness({
      responses: {
        "xoxb-customer conversations.acceptSharedInvite": ["name_taken", {}],
        "xoxb-host conversations.create": ["name_taken", { channel: { id: "C1", name: "acme-inc-superlog-2" } }],
      },
    });

    await connectSlackWorkspace(input, deps);

    expect(
      calls()
        .filter((call) => call.method === "conversations.create")
        .map((call) => call.body.name),
    ).toEqual(["acme-inc-superlog", "acme-inc-superlog-2"]);
    expect(
      calls()
        .filter((call) => call.method === "conversations.acceptSharedInvite")
        .map((call) => call.body.channel_name),
    ).toEqual(["acme-inc-superlog-2", "acme-inc-superlog-2-2"]);
  });

  it("asks for a limited invitation when full access is not allowed", async () => {
    const { calls, deps } = harness({
      responses: {
        "xoxb-host conversations.inviteShared": ["restricted_action", { invite_id: "I1" }],
      },
    });

    await expect(connectSlackWorkspace(input, deps)).resolves.toBe("joined");

    expect(
      calls()
        .filter((call) => call.method === "conversations.inviteShared")
        .map((call) => call.body),
    ).toEqual([
      { channel: "C1", external_limited: "false", user_ids: "U_BOT" },
      { channel: "C1", user_ids: "U_BOT" },
    ]);
  });

  it("retries adding the member until the channel is approved", async () => {
    const { calls, deps, row } = harness({
      responses: {
        "xoxb-customer conversations.invite": ["channel_not_found", {}],
      },
    });

    await expect(connectSlackWorkspace(input, deps)).rejects.toThrow("channel_not_found");
    expect(row).toMatchObject({
      lastError: "Slack conversations.invite failed: channel_not_found",
      status: "accepted",
    });

    const before = calls().length;
    await expect(connectSlackWorkspace(input, deps)).resolves.toBe("joined");
    expect(calls().slice(before)).toEqual([
      {
        body: { channel: "C1", users: "U_MEMBER" },
        method: "conversations.invite",
        token: "xoxb-customer",
      },
    ]);
    expect(row).toMatchObject({ lastError: null, status: "joined" });
  });

  it("treats a member already in the channel as joined", async () => {
    const { deps } = harness({
      responses: { "xoxb-customer conversations.invite": ["already_in_channel"] },
    });

    await expect(connectSlackWorkspace(input, deps)).resolves.toBe("joined");
  });

  it("marks the channel failed when the email invitation is refused", async () => {
    const { deps, row } = harness({
      installation: null,
      responses: { "xoxb-host conversations.inviteShared": ["invalid_email"] },
    });

    await expect(connectSlackWorkspace(input, deps)).resolves.toBe("failed");
    expect(row).toMatchObject({
      lastError: "Slack conversations.inviteShared failed: invalid_email",
      status: "failed",
    });
  });

  it("retries the email invitation after a transient error", async () => {
    const { deps, row } = harness({
      installation: null,
      responses: { "xoxb-host conversations.inviteShared": ["ratelimited"] },
    });

    await expect(connectSlackWorkspace(input, deps)).rejects.toThrow("ratelimited");
    expect(row.status).toBe("pending");
  });

  it("stops once the channel is shared", async () => {
    for (const status of ["failed", "invited", "joined"] as const) {
      const { calls, deps } = harness({ row: { channelId: "C1", channelName: "acme-superlog", status } });
      await expect(connectSlackWorkspace(input, deps)).resolves.toBe(status);
      expect(calls()).toEqual([]);
    }
  });

  it("keeps sharing when the operator members can't be added", async () => {
    const { deps, log } = harness({
      responses: { "xoxb-host conversations.invite": ["user_not_found"] },
    });

    await expect(connectSlackWorkspace(input, deps)).resolves.toBe("joined");
    expect(log).toHaveBeenCalledWith(
      "slack_connect_host_members_failed",
      expect.objectContaining({ channelId: "C1" }),
    );
  });
});
