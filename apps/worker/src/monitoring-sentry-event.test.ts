import * as Sentry from "@sentry/node";
import type { Event, NodeOptions } from "@sentry/node";
import { afterAll, describe, expect, it } from "vitest";
import { initializeErrorMonitoring, reportWorkerException } from "./monitoring.js";

// Runs the real Sentry client so the event is prepared and normalized as it
// would be in production, and records it instead of sending it.
const sent: Event[] = [];
const transport: NonNullable<NodeOptions["transport"]> = () => ({
  flush: async () => true,
  send: async (envelope) => {
    for (const [header, payload] of envelope[1]) {
      if (header.type === "event") sent.push(payload as Event);
    }
    return {};
  },
});
Sentry.init({ defaultIntegrations: false, dsn: "https://public@example.invalid/1", transport });

afterAll(async () => {
  await Sentry.close();
});

describe("worker error monitoring with the Sentry client", () => {
  it("keeps the errors inside an AggregateError after Sentry normalizes the event", async () => {
    initializeErrorMonitoring({ SENTRY_DSN: "https://public@example.invalid/1" });

    await reportWorkerException(
      new AggregateError(
        [new Error("The usage allowance for this billing period is used up")],
        "Automation callback and queued model operation failed",
      ),
      { operation: "automation" },
    );
    await Sentry.flush(2_000);

    expect(sent.at(-1)?.contexts?.aggregated_errors).toEqual({
      error_1: "Error: The usage allowance for this billing period is used up",
    });
  });
});
