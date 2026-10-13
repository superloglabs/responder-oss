import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CellDirectory } from "../../../../packages/core/src/cells.js";
import { cellWebhookRouter, type CellWebhookRouterDependencies } from "./webhook-router.js";

const directory: CellDirectory = {
  cells: [
    { id: "eu", label: "Europe", url: "https://superlog.sh" },
    { id: "us", label: "United States", url: "https://us.superlog.sh" },
  ],
  cookieDomain: ".superlog.sh",
  current: "eu",
};

function harness(overrides: Partial<CellWebhookRouterDependencies> = {}) {
  const handled = vi.fn();
  const dependencies: CellWebhookRouterDependencies = {
    askCell: vi.fn(async () => true),
    cellToken: () => "cell-token",
    directory: () => directory,
    forward: vi.fn(async () => new Response(JSON.stringify({ ok: true, from: "us" }), {
      headers: { "content-type": "application/json" },
      status: 202,
    })),
    hasTenant: vi.fn(async () => false),
    now: () => 0,
    ...overrides,
  };
  const app = new Hono()
    .use("/api/webhooks/*", cellWebhookRouter(dependencies, new Map()))
    .post("/api/webhooks/slack", async (context) => {
      handled(await context.req.text());
      return context.json({ ok: true, from: "eu" });
    });
  return { app, dependencies, handled };
}

const slackEvent = JSON.stringify({ team_id: "T123", type: "event_callback" });
const slackRequest = (headers: Record<string, string> = {}) => ({
  body: slackEvent,
  headers: {
    "content-type": "application/json",
    "x-responder-origin-verify": "edge-secret",
    "x-slack-request-timestamp": "1",
    "x-slack-signature": "v0=abc",
    ...headers,
  },
  method: "POST",
});

describe("cell webhook router", () => {
  beforeEach(() => vi.clearAllMocks());

  it("handles a tenant this cell holds", async () => {
    const { app, dependencies, handled } = harness({ hasTenant: vi.fn(async () => true) });

    const response = await app.request("/api/webhooks/slack", slackRequest());

    await expect(response.json()).resolves.toEqual({ ok: true, from: "eu" });
    expect(handled).toHaveBeenCalledWith(slackEvent);
    expect(dependencies.askCell).not.toHaveBeenCalled();
  });

  it("forwards the unchanged request to the cell that holds the tenant", async () => {
    const { app, dependencies, handled } = harness();

    const response = await app.request("/api/webhooks/slack?retry=1", slackRequest());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, from: "us" });
    expect(handled).not.toHaveBeenCalled();
    expect(dependencies.askCell).toHaveBeenCalledWith(
      directory.cells[1],
      { key: "T123", provider: "slack" },
      "cell-token",
    );
    const [url, init] = vi.mocked(dependencies.forward).mock.calls[0]!;
    expect(url).toBe("https://us.superlog.sh/api/webhooks/slack?retry=1");
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(slackEvent);
    const headers = new Headers(init.headers);
    expect(headers.get("x-slack-signature")).toBe("v0=abc");
    expect(headers.get("x-slack-request-timestamp")).toBe("1");
    expect(headers.get("x-responder-cell-forwarded")).toBe("eu");
    expect(headers.get("x-responder-origin-verify")).toBeNull();
  });

  it("remembers which cell holds a tenant", async () => {
    const { app, dependencies } = harness();

    await app.request("/api/webhooks/slack", slackRequest());
    await app.request("/api/webhooks/slack", slackRequest());

    expect(dependencies.askCell).toHaveBeenCalledTimes(1);
    expect(dependencies.forward).toHaveBeenCalledTimes(2);
  });

  it("handles a tenant no cell holds itself", async () => {
    const { app, dependencies, handled } = harness({ askCell: vi.fn(async () => false) });

    await app.request("/api/webhooks/slack", slackRequest());

    expect(handled).toHaveBeenCalled();
    expect(dependencies.forward).not.toHaveBeenCalled();
  });

  it("never forwards a request another cell already forwarded", async () => {
    const { app, dependencies, handled } = harness();

    await app.request("/api/webhooks/slack", slackRequest({ "x-responder-cell-forwarded": "us" }));

    expect(handled).toHaveBeenCalled();
    expect(dependencies.hasTenant).not.toHaveBeenCalled();
  });

  it("does nothing in a single-cell deployment or without a cell token", async () => {
    for (const overrides of [{ directory: () => null }, { cellToken: () => undefined }]) {
      const { app, dependencies, handled } = harness(overrides);

      await app.request("/api/webhooks/slack", slackRequest());

      expect(handled).toHaveBeenCalled();
      expect(dependencies.hasTenant).not.toHaveBeenCalled();
    }
  });

  it("handles the request itself when the owning cell cannot be asked", async () => {
    const { app, dependencies, handled } = harness({
      askCell: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });

    await app.request("/api/webhooks/slack", slackRequest());

    expect(handled).toHaveBeenCalled();
    expect(dependencies.forward).not.toHaveBeenCalled();
  });

  it("fails the delivery when the owning cell is unreachable, so the provider retries", async () => {
    const { app, handled } = harness({
      forward: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    });

    const response = await app.request("/api/webhooks/slack", slackRequest());

    expect(response.status).toBe(502);
    expect(handled).not.toHaveBeenCalled();
  });
});
