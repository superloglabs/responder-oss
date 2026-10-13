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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(
  overrides: Partial<CellWebhookRouterDependencies> = {},
  cells: CellDirectory = directory,
) {
  const handled = vi.fn();
  const dependencies: CellWebhookRouterDependencies = {
    askCell: vi.fn(async () => true),
    cellToken: () => "cell-token",
    directory: () => cells,
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
    })
    .post("/api/webhooks/discord", async (context) => {
      handled(await context.req.text());
      return context.json({ type: 4 });
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

  it("handles a tenant this cell holds and copies the event to other holders", async () => {
    const { app, dependencies, handled } = harness({ hasTenant: vi.fn(async () => true) });

    const response = await app.request("/api/webhooks/slack", slackRequest());
    await flush();

    await expect(response.json()).resolves.toEqual({ ok: true, from: "eu" });
    expect(handled).toHaveBeenCalledWith(slackEvent);
    expect(dependencies.forward).toHaveBeenCalledWith(
      "https://us.superlog.sh/api/webhooks/slack",
      expect.anything(),
    );
  });

  it("lets only one cell answer an interactive webhook", async () => {
    const { app, dependencies, handled } = harness({ hasTenant: vi.fn(async () => true) });

    await app.request("/api/webhooks/discord", {
      body: JSON.stringify({ guild_id: "G1", type: 2 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await flush();

    expect(handled).toHaveBeenCalled();
    expect(dependencies.askCell).not.toHaveBeenCalled();
    expect(dependencies.forward).not.toHaveBeenCalled();
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

  it("fails the delivery when no cell can be asked, so the provider retries", async () => {
    const { app, dependencies, handled } = harness({
      askCell: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });

    const response = await app.request("/api/webhooks/slack", slackRequest());

    expect(response.status).toBe(502);
    expect(handled).not.toHaveBeenCalled();
    expect(dependencies.forward).not.toHaveBeenCalled();
  });

  it("keeps looking when one cell cannot be asked", async () => {
    const threeCells: CellDirectory = {
      ...directory,
      cells: [...directory.cells, { id: "ap", label: "Asia Pacific", url: "https://ap.superlog.sh" }],
    };
    const { app, dependencies } = harness(
      {
        askCell: vi.fn(async (cell) => {
          if (cell.id === "us") throw new Error("timeout");
          return true;
        }),
      },
      threeCells,
    );

    const response = await app.request("/api/webhooks/slack", slackRequest());

    expect(response.status).toBe(202);
    expect(dependencies.forward).toHaveBeenCalledWith(
      "https://ap.superlog.sh/api/webhooks/slack",
      expect.anything(),
    );
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
