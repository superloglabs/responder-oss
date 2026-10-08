import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "../db/client.js";
import { notifyBillingLimitReached } from "./notifications.js";

vi.mock("../db/client.js", () => ({ getDatabase: vi.fn() }));

const organizationId = "20000000-0000-4000-8000-000000000000";

function query(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown[]) => void) => resolve(rows);
  return chain;
}

function databaseDouble(existingDeliveries: unknown[]) {
  const select = vi
    .fn()
    .mockReturnValueOnce(query(existingDeliveries))
    .mockImplementation(() => query([]));
  vi.mocked(getDatabase).mockReturnValue({ select } as never);
}

describe("billing limit notification channel refresh", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refreshes Slack channels before the first notice of a period", async () => {
    databaseDouble([]);
    const refreshSlackChannels = vi.fn().mockResolvedValue(undefined);

    await notifyBillingLimitReached(organizationId, 1_800_000_000, {
      refreshSlackChannels,
    });

    expect(refreshSlackChannels).toHaveBeenCalledWith(organizationId);
  });

  it("uses cached channels once the period has deliveries", async () => {
    databaseDouble([{ id: "delivery" }]);
    const refreshSlackChannels = vi.fn().mockResolvedValue(undefined);

    await notifyBillingLimitReached(organizationId, 1_800_000_000, {
      refreshSlackChannels,
    });

    expect(refreshSlackChannels).not.toHaveBeenCalled();
  });

  it("continues with the notice when a refresh fails", async () => {
    databaseDouble([]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      notifyBillingLimitReached(organizationId, 1_800_000_000, {
        refreshSlackChannels: vi.fn().mockRejectedValue(new Error("rate_limited")),
      }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(getDatabase)().select).toHaveBeenCalledTimes(4);
  });
});
