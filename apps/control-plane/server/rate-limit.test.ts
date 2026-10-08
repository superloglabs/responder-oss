import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

describe("rate limiter", () => {
  it("allows the limit per window and reports when to retry", () => {
    let time = 0;
    const limiter = createRateLimiter({ limit: 2, now: () => time, windowMs: 60_000 });

    expect(limiter.take("user")).toEqual({ allowed: true });
    expect(limiter.take("user")).toEqual({ allowed: true });
    time = 15_000;
    expect(limiter.take("user")).toEqual({
      allowed: false,
      firstRefusal: true,
      retryAfterSeconds: 45,
    });
    expect(limiter.take("user")).toMatchObject({ allowed: false, firstRefusal: false });

    time = 60_000;
    expect(limiter.take("user")).toEqual({ allowed: true });
  });

  it("counts each key separately", () => {
    const limiter = createRateLimiter({ limit: 1, now: () => 0, windowMs: 60_000 });

    expect(limiter.take("first")).toEqual({ allowed: true });
    expect(limiter.take("second")).toEqual({ allowed: true });
    expect(limiter.take("first").allowed).toBe(false);
  });
});
