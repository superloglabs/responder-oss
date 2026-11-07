import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  extensionConfig,
  extensionProxy,
  forwardExtensionSlackAction,
  isExtensionSlackAction,
  type ExtensionConfig,
} from "./extensions.js";

vi.mock("./tenant.js", () => ({ getActiveTenant: vi.fn() }));

const config: ExtensionConfig = {
  origin: "http://extension.internal:3100",
  token: "extension-token",
  pathPrefix: "/api/example",
  slackActionPrefix: "example:",
};
const member = {
  ok: true as const,
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "admin",
  user: { email: "a@example.com", id: "11111111-1111-4111-8111-111111111111", name: "A" },
};

function proxied(tenant: unknown = member) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "content-type": "application/json", "set-cookie": "leak=1" },
  }));
  const app = new Hono();
  app.get("/api/other", (context) => context.text("application"));
  app.get("/api/example/owned-by-application", (context) => context.text("application"));
  app.all("/api/*", extensionProxy({ config: () => config, tenant: vi.fn().mockResolvedValue(tenant), fetch }));
  return { app, fetch };
}

describe("extension configuration", () => {
  it("is off unless the URL, token, and prefix are set", () => {
    expect(extensionConfig({})).toBeNull();
    expect(extensionConfig({ RESPONDER_EXTENSION_URL: "http://x", RESPONDER_EXTENSION_TOKEN: "t" })).toBeNull();
    expect(extensionConfig({
      RESPONDER_EXTENSION_URL: "http://x:1/", RESPONDER_EXTENSION_TOKEN: "t", RESPONDER_EXTENSION_PATH_PREFIX: "/api/example/",
    })).toEqual({ origin: "http://x:1", token: "t", pathPrefix: "/api/example", slackActionPrefix: null });
  });

  it("turns off for a prefix outside /api or a URL that is not HTTP", () => {
    const base = { RESPONDER_EXTENSION_URL: "http://x", RESPONDER_EXTENSION_TOKEN: "t" };
    expect(extensionConfig({ ...base, RESPONDER_EXTENSION_PATH_PREFIX: "/app" })).toBeNull();
    expect(extensionConfig({ ...base, RESPONDER_EXTENSION_PATH_PREFIX: "/api/auth/../x" })).toBeNull();
    expect(extensionConfig({ ...base, RESPONDER_EXTENSION_URL: "file:///etc", RESPONDER_EXTENSION_PATH_PREFIX: "/api/example" })).toBeNull();
  });

  it("turns off for a URL with a path, query, fragment, or credentials", () => {
    const base = { RESPONDER_EXTENSION_TOKEN: "t", RESPONDER_EXTENSION_PATH_PREFIX: "/api/example" };
    for (const url of ["http://x/base", "http://x/?a=1", "http://x/#a", "http://user:pass@x", "not a url"]) {
      expect(extensionConfig({ ...base, RESPONDER_EXTENSION_URL: url })).toBeNull();
    }
  });
});

describe("extension proxy", () => {
  it("leaves other paths and the application's own routes to the application", async () => {
    const { app, fetch } = proxied();
    expect(await (await app.request("/api/other")).text()).toBe("application");
    expect(await (await app.request("/api/example/owned-by-application")).text()).toBe("application");
    expect(await (await app.request("/api/examples")).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards a member's request with their identity and the token, and no cookies", async () => {
    const { app, fetch } = proxied();
    const response = await app.request("/api/example/findings?days=7", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: {
        cookie: "session=secret",
        "content-type": "application/json",
        "x-responder-user-id": "forged",
        authorization: "Bearer forged",
      },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toBeNull();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://extension.internal:3100/api/example/findings?days=7");
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer extension-token");
    expect(headers.get("x-responder-user-id")).toBe(member.user.id);
    expect(headers.get("x-responder-organization-id")).toBe(member.organizationId);
    expect(headers.get("x-responder-member-role")).toBe("admin");
    expect(headers.get("cookie")).toBeNull();
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"a":1}');
  });

  it("forwards without identity when nobody is signed in", async () => {
    const { app, fetch } = proxied({ ok: false, error: "Unauthorized", status: 401 });
    await app.request("/api/example/health", { headers: { "x-responder-user-id": "forged" } });
    const headers = fetch.mock.calls[0]![1].headers as Headers;
    expect(headers.get("x-responder-user-id")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer extension-token");
  });

  it("keeps the extension's internal routes private however the path is written", async () => {
    const { app, fetch } = proxied();
    for (const path of [
      "/api/example/internal/slack-interactions",
      "/api/example//internal/slack-interactions",
      "/api/example/x/../internal/slack-interactions",
      "/api/example/%2e%2e/example/internal/slack-interactions",
      "/api/example/%2Finternal/slack-interactions",
      "/api/example/a%5c..%5cinternal",
      "/api/example/%69nternal/slack-interactions",
      "/api/example/Internal/slack-interactions",
      "/api/example/findings%3Fx",
    ]) {
      expect((await app.request(`http://localhost${path}`, { method: "POST" })).status, path).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers 502 when the extension cannot be reached", async () => {
    const { app, fetch } = proxied();
    fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await app.request("/api/example/findings")).status).toBe(502);
  });
});

describe("extension Slack actions", () => {
  it("matches only the configured action prefix", () => {
    expect(isExtensionSlackAction([{ action_id: "example:helpful" }], config)).toBe(true);
    expect(isExtensionSlackAction([{ action_id: "feedback" }], config)).toBe(false);
    expect(isExtensionSlackAction([{ action_id: "example:helpful" }], { ...config, slackActionPrefix: null })).toBe(false);
    expect(isExtensionSlackAction([{ action_id: "example:helpful" }], null)).toBe(false);
  });

  it("posts the payload to the extension's internal route with the token", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await forwardExtensionSlackAction({ type: "block_actions" }, config, fetch);
    expect(fetch).toHaveBeenCalledWith(
      "http://extension.internal:3100/api/example/internal/slack-interactions",
      expect.objectContaining({
        method: "POST",
        body: '{"type":"block_actions"}',
        headers: { authorization: "Bearer extension-token", "content-type": "application/json" },
      }),
    );
  });

  it("releases the extension's response body", async () => {
    for (const status of [200, 500]) {
      const cancel = vi.fn().mockResolvedValue(undefined);
      const body = new ReadableStream({ cancel });
      const fetch = vi.fn().mockResolvedValue(new Response(body, { status }));
      const forwarded = forwardExtensionSlackAction({}, config, fetch);
      if (status === 500) await expect(forwarded).rejects.toThrow("500");
      else await forwarded;
      expect(cancel).toHaveBeenCalled();
    }
  });
});
