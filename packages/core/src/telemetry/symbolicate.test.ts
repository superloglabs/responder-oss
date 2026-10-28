import { TraceMap } from "@jridgewell/trace-mapping";
import { describe, expect, it, vi } from "vitest";
import type { ErrorCandidate } from "./error-issues.js";
import { fingerprint } from "./fingerprint.js";
import fixture from "./fixtures/browser-errors.json" with { type: "json" };
import { cleanSourcePath, symbolicateCandidates, symbolicateStack } from "./symbolicate.js";

// The same bug thrown from a minified, debug-ID-tagged bundle in Chromium,
// Firefox, and WebKit, as the browser SDK sent it, with the bundle's map.
const maps = new Map([[fixture.debugId, new TraceMap(JSON.stringify(fixture.map))]]);

function errorFrom(browser: string, mechanism: string) {
  const error = fixture.errors.find((e) => e.browser === browser && e.mechanism === mechanism);
  if (!error) throw new Error(`no ${browser} ${mechanism} error in the fixture`);
  return error;
}

function candidate(overrides: Partial<ErrorCandidate> = {}): ErrorCandidate {
  const error = errorFrom("chromium", "onerror");
  return {
    attrs: { "app.debug_ids": JSON.stringify(error.debugIds) },
    body: error.message,
    candidate_id: "6a0d1c1e-0000-4000-8000-000000000001",
    discovered_ms: "1793000000000",
    exception_message: error.message,
    exception_stacktrace: error.stacktrace,
    exception_type: error.type,
    kind: "log",
    // Keep this cache namespace separate from the worker ingestion fixtures.
    project_id: "0b9f6b9e-2f4a-4c1e-9d2b-3f8a6c1d7e02",
    resource_attrs: {},
    seen_ms: "1793000000000",
    service: "storefront",
    severity: "ERROR",
    span_id: "",
    span_name: "",
    trace_id: "",
    ...overrides,
  };
}

describe("symbolicateStack", () => {
  it("maps Chromium frames to the original functions and lines", () => {
    const error = errorFrom("chromium", "onerror");

    expect(symbolicateStack(error.stacktrace, error.debugIds, maps)).toBe([
      "TypeError: Cannot read properties of undefined (reading 'total')",
      "    at renderTotal (src/cart.js:2:15)",
      "    at loadCart (src/cart.js:7:17)",
      "    at onPay (src/cart.js:12:3)",
    ].join("\n"));
  });

  it("keeps Firefox's format and markers", () => {
    const error = errorFrom("firefox", "onerror");

    expect(symbolicateStack(error.stacktrace, error.debugIds, maps)?.split("\n").slice(1, 5)).toEqual([
      "renderTotal@src/cart.js:2:3",
      "loadCart@src/cart.js:7:17",
      "onPay@src/cart.js:12:3",
      "EventListener.handleEvent*@src/cart.js:11:32",
    ]);
  });

  it("leaves frames from files without a map as they were", () => {
    const stack = "Error: boom\n    at x (https://cdn.example.com/lib.js:1:2)";

    expect(symbolicateStack(stack, { "https://cdn.example.com/lib.js": "5c3e1f0a-8b7d-4e6c-a1f2-9d8e7c6b5a40" }, maps)).toBeNull();
  });

  it("cleans bundler source paths", () => {
    expect(cleanSourcePath("webpack://storefront/./src/cart.ts")).toBe("src/cart.ts");
    expect(cleanSourcePath("../../src/cart.ts")).toBe("src/cart.ts");
    expect(cleanSourcePath("/src/cart.ts")).toBe("src/cart.ts");
  });
});

describe("symbolicateCandidates", () => {
  const load = vi.fn(async (_organizationId: string, debugIds: string[]) =>
    new Map(debugIds.filter((id) => id === fixture.debugId).map((id) => [id, JSON.stringify(fixture.map)])),
  );

  it("groups the same bug from Chromium and Firefox into one fingerprint across builds", async () => {
    const [chromium, firefox] = await symbolicateCandidates(
      [candidate(), candidate({
        attrs: { "app.debug_ids": JSON.stringify(errorFrom("firefox", "onerror").debugIds) },
        exception_message: errorFrom("firefox", "onerror").message,
        exception_stacktrace: errorFrom("firefox", "onerror").stacktrace,
      })],
      load,
    );
    const hash = (c: ErrorCandidate) => fingerprint({ message: c.exception_message, stacktrace: c.exception_stacktrace, type: c.exception_type });

    expect(hash(chromium!).normalizedFrames).toEqual(["renderTotal@src/cart.js", "loadCart@src/cart.js", "onPay@src/cart.js"]);
    expect(hash(firefox!).hash).toBe(hash(chromium!).hash);
    // The original stack stays on the sample.
    expect(chromium?.attrs["exception.stacktrace.minified"]).toBe(errorFrom("chromium", "onerror").stacktrace);
    expect(load).toHaveBeenCalledWith(candidate().project_id, [fixture.debugId]);
  });

  it("names WebKit's frames by their function, though WebKit dropped a tail call", async () => {
    const error = errorFrom("webkit", "onerror");
    const [webkit] = await symbolicateCandidates(
      [candidate({ attrs: { "app.debug_ids": JSON.stringify(error.debugIds) }, exception_stacktrace: error.stacktrace })],
      load,
    );

    expect(webkit?.exception_stacktrace.split("\n").slice(1)).toEqual(["renderTotal@src/cart.js:2:10", "onPay@src/cart.js:12:3"]);
  });

  it("leaves candidates without debug IDs or maps as they were", async () => {
    const plain = candidate({ attrs: {} });
    const unknown = candidate({ attrs: { "app.debug_ids": JSON.stringify({ "https://app.test/assets/app.js": "5c3e1f0a-8b7d-4e6c-a1f2-9d8e7c6b5a40" }) } });
    const broken = candidate({ attrs: { "app.debug_ids": "not json" } });

    expect(await symbolicateCandidates([plain, unknown, broken], load)).toEqual([plain, unknown, broken]);
  });
});
