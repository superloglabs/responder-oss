import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceMapRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const debugId = "8CAC02CA-C924-4C88-916A-615251254DB8";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), save: vi.fn() }));

vi.mock("../management/execute.js", () => ({
  authenticateManagementRequest: mocks.authenticate,
  unauthorizedBody: { code: "unauthorized", error: "Unauthorized" },
}));
vi.mock("../../../../packages/core/src/db/source-maps.js", () => ({ saveSourceMap: mocks.save }));

const app = new Hono().route("/api/v1/source-maps", sourceMapRoutes);
const map = JSON.stringify({ mappings: "AAAA", names: [], sources: ["src/cart.ts"], version: 3 });

function upload(path: string, body = map, authorization = "Bearer slk_key") {
  return app.request(path, { body, headers: { authorization, "content-type": "application/json" }, method: "PUT" });
}

describe("source map uploads", () => {
  afterEach(() => vi.clearAllMocks());

  it("requires a workspace API key", async () => {
    mocks.authenticate.mockResolvedValue(null);
    const response = await upload(`/api/v1/source-maps/${debugId}?file=assets/app.js`, map, "");

    expect(response.status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("stores the map under its debug ID for the key's workspace", async () => {
    mocks.authenticate.mockResolvedValue({ organizationId });
    const response = await upload(`/api/v1/source-maps/${debugId}?file=assets/app-7D4HJW6Y.js&release=1.4.2`);

    expect(response.status).toBe(201);
    expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Headers), "api");
    expect(mocks.save).toHaveBeenCalledWith({
      content: map,
      debugId: debugId.toLowerCase(),
      file: "assets/app-7D4HJW6Y.js",
      organizationId,
      release: "1.4.2",
    });
  });

  it("rejects a missing file, a bad debug ID, and bodies that are not source maps", async () => {
    mocks.authenticate.mockResolvedValue({ organizationId });

    expect((await upload(`/api/v1/source-maps/${debugId}`)).status).toBe(400);
    expect((await upload("/api/v1/source-maps/not-an-id?file=a.js")).status).toBe(400);
    expect((await upload(`/api/v1/source-maps/${debugId}?file=a.js`, "{}")).status).toBe(400);
    expect((await upload(`/api/v1/source-maps/${debugId}?file=a.js`, "<html>")).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
