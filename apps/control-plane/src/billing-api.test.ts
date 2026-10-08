import { describe, expect, it, vi } from "vitest";
import { createBillingEnabledLoader } from "./billing-api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("billing enabled loader", () => {
  it("shares one request across callers", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ enabled: true }));
    const billingEnabled = createBillingEnabledLoader(fetcher);

    await expect(Promise.all([billingEnabled(), billingEnabled()])).resolves.toEqual([true, true]);
    await expect(billingEnabled()).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("asks again after a failed request", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ error: "Too many requests" }, 429))
      .mockResolvedValueOnce(json({ enabled: true }));
    const billingEnabled = createBillingEnabledLoader(fetcher);

    await expect(billingEnabled()).resolves.toBe(false);
    await expect(billingEnabled()).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
