import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorMessage, refreshSentryAgentOptions } from "./agents-api";

describe("API error messages", () => {
  it("surfaces specific validation issues instead of the generic error", () => {
    expect(
      apiErrorMessage(
        {
          error: "Invalid workspace secret",
          issues: [
            { message: "Choose a non-system environment variable name" },
            { message: "Use a hostname without a scheme, path, or port" },
          ],
        },
        400,
      ),
    ).toBe(
      "Choose a non-system environment variable name. Use a hostname without a scheme, path, or port",
    );
  });

  it("falls back to the top-level API error", () => {
    expect(apiErrorMessage({ error: "Agent not found" }, 404)).toBe(
      "Agent not found",
    );
  });
});

describe("refreshing agent Sentry projects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reloads options only after the selected account succeeds", async () => {
    const options = { accounts: [], resources: [], repositories: [], secrets: [] };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ accounts: [{ id: "chosen", status: "working" }] }))).mockResolvedValueOnce(new Response(JSON.stringify(options)));
    vi.stubGlobal("fetch", fetchMock);
    expect(await refreshSentryAgentOptions("chosen")).toEqual(options);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/integrations/sentry/check", "/api/agents/options"]);
  });

  it("keeps stale resources from being presented as a successful refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accounts: [{ id: "chosen", status: "unavailable" }] })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(refreshSentryAgentOptions("chosen")).rejects.toThrow("Couldn’t load projects");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks to reconnect an account with expired access", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ accounts: [{ id: "chosen", status: "needs_reconnect" }] }))));
    await expect(refreshSentryAgentOptions("chosen")).rejects.toThrow("Reconnect Sentry");
  });
});
