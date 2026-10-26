import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CellDirectory } from "../../../../packages/core/src/cells.js";
import {
  legacyWebhookForwarder,
  legacyWebhookRoutes,
  type LegacyWebhookForwarderDependencies,
} from "./legacy-webhook-forwarder.js";

const directory: CellDirectory = {
  cells: [
    { id: "eu", label: "Europe", url: "https://superlog.sh" },
    { id: "us", label: "United States", url: "https://us.superlog.sh" },
  ],
  cookieDomain: ".superlog.sh",
  current: "eu",
};

const legacyApp = "A0LEGACY";
const routes = [
  { appIds: [legacyApp], path: "/api/webhooks/slack", url: "https://api.superlog.sh/slack/events" },
  { appIds: [legacyApp], path: "/api/webhooks/slack/actions", url: "https://api.superlog.sh/slack/interactivity" },
];

function harness(overrides: Partial<LegacyWebhookForwarderDependencies> = {}) {
  const handled = vi.fn();
  const dependencies: LegacyWebhookForwarderDependencies = {
    askCell: vi.fn(async () => ({ active: false, held: false })),
    cellToken: () => "cell-token",
    directory: () => directory,
    forward: vi.fn(async () => new Response(JSON.stringify({ from: "legacy" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    })),
    routes: () => routes,
    tenantState: vi.fn(async () => ({ active: false, held: false })),
    ...overrides,
  };
  const app = new Hono()
    .use("/api/webhooks/*", legacyWebhookForwarder(dependencies))
    .post("/api/webhooks/slack", async (context) => {
      handled(await context.req.text());
      return context.json({ from: "application" });
    })
    .post("/api/webhooks/slack/actions", async (context) => {
      handled(await context.req.text());
      return context.json({ from: "application" });
    });
  return { app, dependencies, handled };
}

const event = (appId: string) => ({
  body: JSON.stringify({ api_app_id: appId, team_id: "T123", type: "event_callback" }),
  headers: {
    "content-type": "application/json",
    "x-responder-origin-verify": "edge-secret",
    "x-slack-request-timestamp": "1",
    "x-slack-signature": "v0=abc",
  },
  method: "POST",
});

const interaction = (appId: string) => ({
  body: new URLSearchParams({
    payload: JSON.stringify({ api_app_id: appId, team: { id: "T123" }, type: "block_actions" }),
  }).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-signature": "v0=abc" },
  method: "POST",
});

describe("legacy webhook forwarder", () => {
  it("leaves requests from the application's own apps alone", async () => {
    const { app, dependencies, handled } = harness();

    const response = await app.request("/api/webhooks/slack", event("A0CURRENT"));

    expect(await response.json()).toEqual({ from: "application" });
    expect(handled).toHaveBeenCalledOnce();
    expect(dependencies.forward).not.toHaveBeenCalled();
  });

  it("sends an old app's event to both products and returns the old product's answer", async () => {
    const { app, dependencies, handled } = harness();

    const response = await app.request("/api/webhooks/slack", event(legacyApp));

    expect(await response.json()).toEqual({ from: "legacy" });
    expect(handled).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(dependencies.forward).mock.calls[0]!;
    expect(url).toBe("https://api.superlog.sh/slack/events");
    const headers = new Headers(init.headers);
    expect(headers.get("x-slack-signature")).toBe("v0=abc");
    expect(headers.get("x-responder-origin-verify")).toBeNull();
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(event(legacyApp).body);
  });

  it("fails the delivery when the old product cannot take an event, so the provider retries", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, handled } = harness({ forward: vi.fn(async () => { throw new Error("down"); }) });

    const response = await app.request("/api/webhooks/slack", event(legacyApp));

    expect(response.status).toBe(502);
    expect(handled).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("gives an interaction to the old product unless an active workspace holds the tenant", async () => {
    const paused = harness({ tenantState: vi.fn(async () => ({ active: false, held: true })) });
    expect(await (await paused.app.request("/api/webhooks/slack/actions", interaction(legacyApp))).json())
      .toEqual({ from: "legacy" });
    expect(paused.handled).not.toHaveBeenCalled();
    expect(vi.mocked(paused.dependencies.forward).mock.calls[0]![0]).toBe("https://api.superlog.sh/slack/interactivity");

    const local = harness({ tenantState: vi.fn(async () => ({ active: true, held: true })) });
    expect(await (await local.app.request("/api/webhooks/slack/actions", interaction(legacyApp))).json())
      .toEqual({ from: "application" });
    expect(local.dependencies.forward).not.toHaveBeenCalled();

  });

  it("hands an interaction to the cell whose active workspace holds the tenant", async () => {
    const { app, dependencies, handled } = harness({
      askCell: vi.fn(async () => ({ active: true, held: true })),
      // A paused copy here must not take it.
      tenantState: vi.fn(async () => ({ active: false, held: true })),
    });

    await app.request("/api/webhooks/slack/actions", interaction(legacyApp));

    expect(handled).not.toHaveBeenCalled();
    expect(dependencies.askCell).toHaveBeenCalledWith(directory.cells[1], { key: "T123", provider: "slack" }, "cell-token");
    const [url, init] = vi.mocked(dependencies.forward).mock.calls[0]!;
    expect(url).toBe("https://us.superlog.sh/api/webhooks/slack/actions");
    expect(new Headers(init.headers).get("x-responder-cell-forwarded")).toBe("eu");
  });

  it("stops asking cells at the first active answer", async () => {
    const threeCells: CellDirectory = {
      ...directory,
      cells: [...directory.cells, { id: "ap", label: "Asia", url: "https://ap.superlog.sh" }],
    };
    const { app, dependencies } = harness({
      askCell: vi.fn(async (cell) => cell.id === "us"
        ? { active: true, held: true }
        : new Promise<never>(() => undefined)),
      directory: () => threeCells,
    });

    await app.request("/api/webhooks/slack/actions", interaction(legacyApp));

    expect(vi.mocked(dependencies.forward).mock.calls[0]![0]).toBe("https://us.superlog.sh/api/webhooks/slack/actions");
  });

  it("does nothing without configured routes, and rejects a malformed configuration", async () => {
    const { app, dependencies } = harness({ routes: () => [] });
    expect(await (await app.request("/api/webhooks/slack", event(legacyApp))).json()).toEqual({ from: "application" });
    expect(dependencies.forward).not.toHaveBeenCalled();

    expect(legacyWebhookRoutes({})).toEqual([]);
    expect(legacyWebhookRoutes({ LEGACY_WEBHOOK_FORWARDS: JSON.stringify(routes) })).toEqual(routes);
    expect(() => legacyWebhookRoutes({ LEGACY_WEBHOOK_FORWARDS: "[{\"path\":\"/x\"}]" })).toThrow(/LEGACY_WEBHOOK_FORWARDS/u);
  });
});
