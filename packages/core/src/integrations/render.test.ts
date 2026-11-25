import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RenderApiError,
  renderErrorKind,
  renderExternalAccountId,
  type RenderFetch,
  renderLogsPage,
  renderReadables,
  renderServices,
  renderUser,
  renderWorkspaces,
} from "./render.js";

const apiKey = "rnd_test_key_0000";

function stub(responses: Array<Response | (() => Response)>) {
  const urls: URL[] = [];
  const inits: RequestInit[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn<RenderFetch>(async (input, init) => {
    urls.push(new URL(input));
    inits.push(init);
    const next = queue.shift();
    if (!next) throw new Error("No more responses");
    return typeof next === "function" ? next() : next;
  });
  return { fetch: fetchFn, inits, urls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("renderWorkspaces", () => {
  it("lists every workspace the key reaches, following cursors, with the key as a bearer token", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ cursor: `c${index}`, owner: { id: `tea-${index}`, name: `Team ${index}` } }));
    const api = stub([Response.json(first), Response.json([{ cursor: "c100", owner: { id: "usr-1", name: "" } }, { cursor: "x", owner: null }])]);

    const workspaces = await renderWorkspaces({ apiKey, fetch: api.fetch });

    expect(workspaces).toHaveLength(101);
    expect(workspaces.at(-1)).toEqual({ id: "usr-1", name: "usr-1" });
    expect(api.urls[0]!.pathname).toBe("/v1/owners");
    expect(api.urls[1]!.searchParams.get("cursor")).toBe("c99");
    expect((api.inits[0]!.headers as Record<string, string>).authorization).toBe(`Bearer ${apiKey}`);
  });

  it("reads from the server RENDER_API_URL names", async () => {
    vi.stubEnv("RENDER_API_URL", "http://127.0.0.1:4999/v1/");
    const api = stub([Response.json([])]);

    await renderWorkspaces({ apiKey, fetch: api.fetch });

    expect(api.urls[0]!.href).toBe("http://127.0.0.1:4999/v1/owners?limit=100");
  });
});

describe("renderServices", () => {
  it("reads each service's region and whether it is suspended", async () => {
    const api = stub([Response.json([
      { cursor: "a", service: { id: "srv-web", name: "web", ownerId: "tea-1", serviceDetails: { region: "oregon" }, suspended: "not_suspended", type: "web_service" } },
      { cursor: "b", service: { id: "srv-old", name: "old", ownerId: "tea-1", suspended: "suspended", type: "background_worker" } },
      { cursor: "c", service: { name: "no id" } },
    ])]);

    const services = await renderServices({ apiKey, fetch: api.fetch, ownerId: "tea-1" });

    expect(services).toEqual([
      { id: "srv-web", name: "web", ownerId: "tea-1", region: "oregon", suspended: false, type: "web_service" },
      { id: "srv-old", name: "old", ownerId: "tea-1", region: null, suspended: true, type: "background_worker" },
    ]);
    expect(api.urls[0]!.searchParams.get("ownerId")).toBe("tea-1");
  });
});

describe("renderLogsPage", () => {
  it("asks for one forward page across the services and reads the next page's bounds", async () => {
    const api = stub([Response.json({
      hasMore: true,
      logs: [
        { id: "l1", labels: [{ name: "resource", value: "srv-web" }, { name: "level", value: "error" }], message: "boom", timestamp: "2026-11-25T10:00:00.123456Z" },
        { labels: "broken", message: 3, timestamp: "2026-11-25T10:00:01Z" },
        { message: "no time" },
      ],
      nextEndTime: "2026-11-25T10:04:40Z",
      nextStartTime: "2026-11-25T10:00:01Z",
    })]);

    const page = await renderLogsPage({
      apiKey,
      endTime: "2026-11-25T10:04:40Z",
      fetch: api.fetch,
      limit: 100,
      ownerId: "tea-1",
      resources: ["srv-web", "srv-worker"],
      startTime: "2026-11-25T09:59:40Z",
    });

    const query = api.urls[0]!.searchParams;
    expect(api.urls[0]!.pathname).toBe("/v1/logs");
    expect(query.getAll("resource")).toEqual(["srv-web", "srv-worker"]);
    expect(query.get("direction")).toBe("forward");
    expect(query.get("limit")).toBe("100");
    expect(query.get("ownerId")).toBe("tea-1");
    expect(page.hasMore).toBe(true);
    expect(page.nextStartTime).toBe("2026-11-25T10:00:01Z");
    expect(page.logs).toEqual([
      { id: "l1", labels: [{ name: "resource", value: "srv-web" }, { name: "level", value: "error" }], message: "boom", timestamp: "2026-11-25T10:00:00.123456Z" },
      { id: null, labels: [], message: "", timestamp: "2026-11-25T10:00:01Z" },
    ]);
  });
});

describe("Render errors", () => {
  const page = (fetchFn: RenderFetch) => renderLogsPage({
    apiKey, endTime: "2026-11-25T10:01:00Z", fetch: fetchFn, limit: 100, ownerId: "tea-1", resources: ["srv-web"], startTime: "2026-11-25T10:00:00Z",
  });

  it.each([
    [401, { message: "unauthorized" }, "unauthorized"],
    [403, { message: "forbidden" }, "unauthorized"],
    [429, { message: "rate limit exceeded" }, "retry_later"],
    [400, { message: "rate limit exceeded" }, "retry_later"],
    [503, { message: "log retrieval is currently unavailable" }, "retry_later"],
    [500, { message: "Log retrieval is currently unavailable, please try again" }, "retry_later"],
    [500, { message: "internal error" }, "failed"],
  ] as const)("reads HTTP %i %j as %s", async (status, body, kind) => {
    const api = stub([Response.json(body, { status })]);

    const failure = await page(api.fetch).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RenderApiError);
    expect((failure as RenderApiError).kind).toBe(kind);
    expect((failure as RenderApiError).message).not.toContain(apiKey);
  });

  it("takes the key out of an error that repeats it", async () => {
    const api = stub([Response.json({ message: `invalid key ${apiKey}` }, { status: 400 }), new Response(`bad ${apiKey}`, { status: 500 })]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = (await page(api.fetch).catch((error: unknown) => error)) as RenderApiError;
      expect(failure.message).not.toContain(apiKey);
      expect(failure.message).toContain("[redacted]");
    }
    const unreachable = (await page(async () => { throw new Error(`socket closed for ${apiKey}`); }).catch((error: unknown) => error)) as RenderApiError;
    expect(unreachable.message).toBe("Render could not be reached: socket closed for [redacted]");
  });

  it("reads a plain-text error body", async () => {
    const api = stub([new Response("rate limit exceeded", { status: 429 })]);

    const failure = (await page(api.fetch).catch((error: unknown) => error)) as RenderApiError;

    expect(failure.kind).toBe("retry_later");
    expect(failure.message).toBe("Render answered 429: rate limit exceeded");
  });

  it("reports an unreachable server without the key", async () => {
    const failure = (await page(async () => { throw new Error("connect ECONNREFUSED"); }).catch((error: unknown) => error)) as RenderApiError;

    expect(failure.kind).toBe("failed");
    expect(failure.message).toBe("Render could not be reached: connect ECONNREFUSED");
  });

  it("classifies by status first", () => {
    expect(renderErrorKind(401, "rate limit exceeded")).toBe("unauthorized");
    expect(renderErrorKind(null, "fetch failed")).toBe("failed");
  });
});

describe("renderUser and renderExternalAccountId", () => {
  it("identifies a connection by its user's email", async () => {
    const api = stub([Response.json({ email: "Dev@Example.com", name: "Dev" })]);

    const user = await renderUser({ apiKey, fetch: api.fetch });

    expect(api.urls[0]!.pathname).toBe("/v1/users");
    expect(renderExternalAccountId({ apiKey, email: user?.email ?? null })).toBe("dev@example.com");
  });

  it("falls back to a hash of the key that does not contain it", () => {
    const id = renderExternalAccountId({ apiKey, email: null });

    expect(id).toMatch(/^key-[0-9a-f]{16}$/u);
    expect(id).not.toContain(apiKey);
    expect(renderExternalAccountId({ apiKey, email: null })).toBe(id);
  });
});

describe("renderReadables", () => {
  it("offers each workspace and its running services", async () => {
    const api = stub([
      Response.json([{ cursor: "a", owner: { id: "tea-1", name: "Example Team" } }]),
      Response.json([
        { cursor: "a", service: { id: "srv-web", name: "web", serviceDetails: { region: "ohio" }, suspended: "not_suspended", type: "web_service" } },
        { cursor: "b", service: { id: "srv-old", name: "old", suspended: "suspended", type: "web_service" } },
      ]),
    ]);

    expect(await renderReadables({ apiKey, fetch: api.fetch })).toEqual([
      { id: "tea-1", kind: "workspace", ownerId: "tea-1", workspaceName: "Example Team" },
      { id: "srv-web", kind: "service", ownerId: "tea-1", region: "ohio", serviceName: "web", serviceType: "web_service", workspaceName: "Example Team" },
    ]);
  });
});
