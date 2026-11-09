import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAwsLogStreaming, saveAwsLogStreaming } from "./aws-log-subscriptions-api";

const accountId = "44444444-4444-4444-8444-444444444444";

function answer(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("AWS log streaming client", () => {
  it("reads the streaming state", async () => {
    answer(200, {
      available: true,
      canManage: true,
      filter: "Error lines only",
      regions: ["eu-west-1"],
      stackUpdate: null,
      subscriptions: [{ appliedAt: null, lastError: null, region: "eu-west-1", status: "pending" }],
    });
    expect(await fetchAwsLogStreaming(accountId)).toEqual({
      available: true,
      canManage: true,
      filter: "Error lines only",
      regions: ["eu-west-1"],
      stackUpdate: null,
      subscriptions: [{ appliedAt: null, lastError: null, region: "eu-west-1", status: "pending" }],
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(`/api/integrations/aws/log-subscriptions/${accountId}`);
  });

  it("treats an answer without the fields, or a missing route, as no streaming", async () => {
    answer(200, {});
    expect(await fetchAwsLogStreaming(accountId)).toMatchObject({ available: false, canManage: false, regions: [], subscriptions: [] });
    answer(404, { error: "Not found" });
    expect(await fetchAwsLogStreaming(accountId)).toMatchObject({ available: false });
  });

  it("shows the server's error when loading or saving fails", async () => {
    answer(500, { error: "Database unavailable" });
    await expect(fetchAwsLogStreaming(accountId)).rejects.toThrow("Database unavailable");
    answer(403, { error: "Only workspace owners and admins can change log streaming" });
    await expect(saveAwsLogStreaming(accountId, ["eu-west-1"])).rejects.toThrow("Only workspace owners and admins");
    answer(404, { error: "AWS connection not found" });
    await expect(saveAwsLogStreaming(accountId, ["eu-west-1"])).rejects.toThrow("AWS connection not found");
  });

  it("sends the chosen regions", async () => {
    answer(200, { available: true, canManage: true, regions: ["eu-west-1"], stackUpdate: null, subscriptions: [] });
    await saveAwsLogStreaming(accountId, ["eu-west-1", "us-east-1"]);
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(init).toMatchObject({ method: "PUT" });
    expect(JSON.parse(init!.body as string)).toEqual({ regions: ["eu-west-1", "us-east-1"] });
  });
});
