import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findAutomationsForDiscordCommand: vi.fn(),
  queueAutomationRun: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  findAutomationsForDiscordCommand: mocks.findAutomationsForDiscordCommand,
}));

vi.mock("../automations/queue.js", () => ({
  queueAutomationRun: mocks.queueAutomationRun,
}));

import {
  discordWebhookRoutes,
  verifyDiscordSignature,
} from "./discord.js";

function rawPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("hex");
}

function signedRequest(input: {
  body: unknown;
  privateKey: KeyObject;
  publicKey: KeyObject;
}) {
  const rawBody = JSON.stringify(input.body);
  const timestamp = "1700000000";
  const signature = sign(
    null,
    Buffer.from(`${timestamp}${rawBody}`),
    input.privateKey,
  ).toString("hex");
  return {
    publicKey: rawPublicKey(input.publicKey),
    request: new Request("http://localhost/api/webhooks/discord", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      },
      body: rawBody,
    }),
  };
}

describe("Discord webhook", () => {
  const keys = generateKeyPairSync("ed25519");
  const app = new Hono().route("/api/webhooks/discord", discordWebhookRoutes);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DISCORD_PUBLIC_KEY", rawPublicKey(keys.publicKey));
    mocks.findAutomationsForDiscordCommand.mockResolvedValue([]);
    mocks.queueAutomationRun.mockResolvedValue({ created: true, runId: "run-1" });
  });

  it("verifies Ed25519 signatures and answers endpoint pings", async () => {
    const signed = signedRequest({
      body: { type: 1 },
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    expect(
      verifyDiscordSignature({
        publicKey: signed.publicKey,
        rawBody: await signed.request.clone().text(),
        signature: signed.request.headers.get("x-signature-ed25519") ?? undefined,
        timestamp: signed.request.headers.get("x-signature-timestamp") ?? undefined,
      }),
    ).toBe(true);

    const response = await app.request(signed.request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("fans a channel command into matching automations", async () => {
    mocks.findAutomationsForDiscordCommand.mockResolvedValue([
      { automationId: "automation-1" },
      { automationId: "automation-2" },
    ]);
    const signed = signedRequest({
      body: {
        application_id: "application-1",
        channel_id: "channel-1",
        data: {
          name: "automate",
          options: [{ name: "context", type: 3, value: "Investigate latency" }],
        },
        guild_id: "guild-1",
        id: "interaction-1",
        member: {
          user: {
            global_name: "Operator",
            id: "user-1",
            username: "operator",
          },
        },
        type: 2,
      },
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });

    const response = await app.request(signed.request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { content: "2 automations started.", flags: 64 },
      type: 4,
    });
    expect(mocks.findAutomationsForDiscordCommand).toHaveBeenCalledWith({
      channelId: "channel-1",
      guildId: "guild-1",
    });
    expect(mocks.queueAutomationRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        automationId: "automation-1",
        trigger: expect.objectContaining({
          body: "Investigate latency",
          externalEventId: "interaction-1:automation-1",
          provider: "discord",
        }),
      }),
    );
  });

  it("rejects unsigned requests", async () => {
    const response = await app.request("/api/webhooks/discord", {
      method: "POST",
      body: JSON.stringify({ type: 1 }),
    });
    expect(response.status).toBe(401);
    expect(mocks.findAutomationsForDiscordCommand).not.toHaveBeenCalled();
  });
});
