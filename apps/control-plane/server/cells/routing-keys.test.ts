import { describe, expect, it } from "vitest";
import { webhookRoutingKey } from "./routing-keys.js";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("webhook routing keys", () => {
  it("routes Slack events by team", () => {
    expect(
      webhookRoutingKey("/api/webhooks/slack", "application/json", json({ team_id: "T123", type: "event_callback" })),
    ).toEqual({ provider: "slack", key: "T123" });
    expect(
      webhookRoutingKey(
        "/api/webhooks/slack",
        "application/json",
        json({ authorizations: [{ team_id: "T456" }], type: "event_callback" }),
      ),
    ).toEqual({ provider: "slack", key: "T456" });
  });

  it("leaves Slack URL verification to the receiving cell", () => {
    expect(
      webhookRoutingKey("/api/webhooks/slack", "application/json", json({ challenge: "x", type: "url_verification" })),
    ).toBeNull();
  });

  it("routes Slack interactions by the team in the form payload", () => {
    const body = new TextEncoder().encode(
      `payload=${encodeURIComponent(JSON.stringify({ team: { id: "T789" }, type: "block_actions" }))}`,
    );
    expect(
      webhookRoutingKey("/api/webhooks/slack/actions", "application/x-www-form-urlencoded", body),
    ).toEqual({ provider: "slack", key: "T789" });
  });

  it("routes Discord interactions by guild and leaves PING to the receiving cell", () => {
    expect(
      webhookRoutingKey("/api/webhooks/discord", "application/json", json({ guild_id: "G1", type: 2 })),
    ).toEqual({ provider: "discord", key: "G1" });
    expect(webhookRoutingKey("/api/webhooks/discord", "application/json", json({ type: 1 }))).toBeNull();
  });

  it("routes Linear, Sentry, and GitHub by their installation or organization", () => {
    expect(
      webhookRoutingKey("/api/webhooks/linear", "application/json", json({ organizationId: "org-1" })),
    ).toEqual({ provider: "linear", key: "org-1" });
    expect(
      webhookRoutingKey("/api/webhooks/sentry", "application/json", json({ installation: { uuid: "inst-1" } })),
    ).toEqual({ provider: "sentry", key: "inst-1" });
    expect(
      webhookRoutingKey("/api/webhooks/github", "application/json", json({ installation: { id: 42 } })),
    ).toEqual({ provider: "github", key: "42" });
  });

  it("routes per-account webhooks by the account in the path", () => {
    const id = "0f0c8e9a-1d4b-4f43-9b1d-0d2b3f1a2c3d";
    for (const provider of ["dash0", "axiom", "devrev"]) {
      expect(webhookRoutingKey(`/api/webhooks/${provider}/${id}`, "application/json", json({}))).toEqual({
        key: id,
        provider: "integration_account",
      });
    }
    expect(webhookRoutingKey("/api/webhooks/dash0/not-a-uuid", "application/json", json({}))).toBeNull();
  });

  it("returns no key for unknown paths or unreadable bodies", () => {
    expect(webhookRoutingKey("/api/webhooks/unknown", "application/json", json({ team_id: "T1" }))).toBeNull();
    expect(webhookRoutingKey("/api/webhooks/slack", "application/json", new TextEncoder().encode("{"))).toBeNull();
    expect(webhookRoutingKey("/api/webhooks/github", "application/json", json({ installation: {} }))).toBeNull();
  });
});
