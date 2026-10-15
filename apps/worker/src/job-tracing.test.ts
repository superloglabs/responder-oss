import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { tracedJobHandler } from "./job-tracing.js";

function fakeTracer() {
  const span = { end: vi.fn(), recordException: vi.fn(), setStatus: vi.fn() };
  const startActiveSpan = vi.fn((_name: string, _options: unknown, run: (value: typeof span) => unknown) => run(span));
  vi.spyOn(trace, "getTracer").mockReturnValue({ startActiveSpan } as never);
  return { span, startActiveSpan };
}

describe("job tracing", () => {
  it("runs each job in a root consumer span named for its queue", async () => {
    const { span, startActiveSpan } = fakeTracer();
    vi.resetModules();
    const { tracedJobHandler: traced } = await import("./job-tracing.js");

    const handler = traced("automation-run", async ([job]: Array<{ data: unknown; id: string }>) => `done ${job!.id}`);
    await expect(handler([{ data: {}, id: "job-1" }])).resolves.toBe("done job-1");

    expect(startActiveSpan).toHaveBeenCalledWith(
      "process automation-run",
      {
        attributes: {
          "messaging.batch.message_count": 1,
          "messaging.destination.name": "automation-run",
          "messaging.message.id": "job-1",
          "messaging.operation.type": "process",
          "messaging.system": "pg-boss",
        },
        kind: SpanKind.CONSUMER,
        root: true,
      },
      expect.any(Function),
    );
    expect(span.end).toHaveBeenCalledTimes(1);
    expect(span.setStatus).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("marks the span failed and rethrows the job's error", async () => {
    const { span } = fakeTracer();
    vi.resetModules();
    const { tracedJobHandler: traced } = await import("./job-tracing.js");
    const error = new Error("sandbox unavailable");

    await expect(traced("investigation", async () => { throw error; })([{ data: {}, id: "job-2" }])).rejects.toBe(error);

    expect(span.recordException).toHaveBeenCalledWith(error);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: "sandbox unavailable" });
    expect(span.end).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("returns the handler's result without a tracer provider", async () => {
    await expect(tracedJobHandler("worker-health", async () => 42)([{ data: {}, id: "job-3" }])).resolves.toBe(42);
  });
});
