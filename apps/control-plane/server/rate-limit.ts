export type RateLimitResult =
  | { allowed: true }
  // `firstRefusal` is true once per key and window, so callers can log once.
  | { allowed: false; firstRefusal: boolean; retryAfterSeconds: number };

// Counts requests per key in fixed windows. Counts live in this process, so
// each API task enforces the limit on its own.
export function createRateLimiter({
  limit,
  now = Date.now,
  windowMs,
}: {
  limit: number;
  now?: () => number;
  windowMs: number;
}) {
  const windows = new Map<
    string,
    { count: number; refused: boolean; resetAt: number }
  >();
  let nextSweepAt = 0;

  return {
    take(key: string): RateLimitResult {
      const time = now();
      if (time >= nextSweepAt) {
        for (const [windowKey, window] of windows) {
          if (window.resetAt <= time) windows.delete(windowKey);
        }
        nextSweepAt = time + windowMs;
      }

      const current = windows.get(key);
      if (!current || current.resetAt <= time) {
        windows.set(key, { count: 1, refused: false, resetAt: time + windowMs });
        return { allowed: true };
      }
      if (current.count >= limit) {
        const firstRefusal = !current.refused;
        current.refused = true;
        return {
          allowed: false,
          firstRefusal,
          retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - time) / 1000)),
        };
      }
      current.count += 1;
      return { allowed: true };
    },
  };
}
