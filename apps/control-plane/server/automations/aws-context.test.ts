import { afterEach, describe, expect, it, vi } from "vitest";
import { awsContextFetch } from "./aws-context.js";

describe("AWS context requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("gives requests the investigation time limit and keeps the caller's abort", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const caller = new AbortController();

    await awsContextFetch("https://aws-mcp.us-east-1.api.aws/mcp", {
      method: "POST",
      signal: caller.signal,
    });

    expect(timeout).toHaveBeenCalledWith(60_000);
    const signal = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });
});
