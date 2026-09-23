import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveTenant } from "../tenant.js";
import { getSuggestionFilters, getSuggestionSettings, listSuggestions, setSuggestionDismissed } from "../../../../packages/core/src/db/suggestions.js";
import { suggestionRoutes } from "./routes.js";

vi.mock("../tenant.js", () => ({ getActiveTenant: vi.fn() }));
vi.mock("../../../../packages/core/src/db/suggestions.js", () => ({
  getSuggestionDetail: vi.fn(), getSuggestionFilters: vi.fn(), getSuggestionSettings: vi.fn(),
  listSuggestions: vi.fn(), setSuggestionSettings: vi.fn(), setSuggestionDismissed: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/suggestion-pull-requests.js", () => ({
  queueSuggestionPullRequests: vi.fn(), SuggestionPullRequestError: class extends Error {},
}));
vi.mock("../investigations/queue.js", () => ({ queueSuggestionRemediation: vi.fn() }));

const app = new Hono().route("/suggestions", suggestionRoutes);
const suggestionId = "11111111-1111-4111-a111-111111111111";
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getActiveTenant).mockResolvedValue({ ok: true, organizationId: "workspace-a", user: { id: "user", email: "test@example.com", name: "Test" } });
});
describe("suggestion filters and dismissal", () => {
  it("passes filters and cursor through with the authenticated workspace", async () => {
    const nextCursor = { createdAt: "2026-08-30T00:00:00.000Z", id: suggestionId };
    vi.mocked(listSuggestions).mockResolvedValue({ suggestions: [], nextCursor });
    vi.mocked(getSuggestionSettings).mockResolvedValue({ autoOpenPullRequests: false });
    vi.mocked(getSuggestionFilters).mockResolvedValue([{ source: "sentry", status: "dismissed", count: 2 }]);
    const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-09-01T00:00:00.000Z", id: suggestionId })).toString("base64url");
    const response = await app.request(`/suggestions?status=dismissed&source=sentry&cursor=${cursor}`);
    expect(response.status).toBe(200);
    expect(listSuggestions).toHaveBeenCalledWith("workspace-a", { limit: 50, status: "dismissed", source: "sentry", cursor: { createdAt: "2026-09-01T00:00:00.000Z", id: suggestionId } });
    const body = await response.json();
    expect(body.filters).toEqual([{ source: "sentry", status: "dismissed", count: 2 }]);
    expect(JSON.parse(Buffer.from(body.nextCursor, "base64url").toString())).toEqual(nextCursor);
    const nextPage = await app.request(`/suggestions?status=dismissed&source=sentry&cursor=${body.nextCursor}`);
    expect(nextPage.status).toBe(200);
    expect(listSuggestions).toHaveBeenLastCalledWith("workspace-a", { limit: 50, status: "dismissed", source: "sentry", cursor: nextCursor });
  });
  it.each(["not-json", Buffer.from(JSON.stringify({ createdAt: "not-a-date", id: suggestionId })).toString("base64url")])("rejects malformed cursor %s before querying", async (cursor) => {
    expect((await app.request(`/suggestions?cursor=${cursor}`)).status).toBe(400);
    expect(listSuggestions).not.toHaveBeenCalled();
  });
  it.each([true, false])("saves dismissed=%s within the active workspace", async (dismissed) => {
    vi.mocked(setSuggestionDismissed).mockResolvedValue({ id: suggestionId });
    const response = await app.request(`/suggestions/${suggestionId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dismissed, organizationId: "another-workspace" }) });
    expect(response.status).toBe(200);
    expect(setSuggestionDismissed).toHaveBeenCalledWith("workspace-a", suggestionId, dismissed);
  });
  it("returns 404 when a suggestion is not found in the workspace", async () => {
    vi.mocked(setSuggestionDismissed).mockResolvedValue(null);
    const response = await app.request(`/suggestions/${suggestionId}`, { method: "PATCH", body: JSON.stringify({ dismissed: true }) });
    expect(response.status).toBe(404);
  });
  it("rejects invalid status and malformed updates before querying", async () => {
    expect((await app.request("/suggestions?status=invalid")).status).toBe(400);
    expect((await app.request(`/suggestions/${suggestionId}`, { method: "PATCH", body: JSON.stringify({ dismissed: "yes" }) })).status).toBe(400);
    expect(listSuggestions).not.toHaveBeenCalled();
    expect(setSuggestionDismissed).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated updates", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue({ ok: false, error: "Unauthorized", status: 401 });
    expect((await app.request(`/suggestions/${suggestionId}`, { method: "PATCH", body: JSON.stringify({ dismissed: true }) })).status).toBe(401);
    expect(setSuggestionDismissed).not.toHaveBeenCalled();
  });
});
