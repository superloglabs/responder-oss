import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranscriptRecorder, watchHarnessEvents } from "./automation-live-transcript.js";

const message = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
const reasoning = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "reasoning", text } });

describe("createTranscriptRecorder", () => {
  it("inserts the transcript once, then updates it as items arrive", async () => {
    let now = 1_000;
    const insert = vi.fn().mockResolvedValue(7);
    const update = vi.fn().mockResolvedValue(undefined);
    const recorder = createTranscriptRecorder({ harness: "codex", insert, now: () => now, onError: vi.fn(), update });

    await recorder.update("");
    expect(insert).not.toHaveBeenCalled();

    now = 3_000;
    await recorder.update(reasoning("Check the handler."));
    now = 9_000;
    await recorder.update(`${reasoning("Check the handler.")}\n${message("Found it.")}`);
    await recorder.update(`${reasoning("Check the handler.")}\n${message("Found it.")}`);
    now = 12_000;
    const final = await recorder.finish(`${reasoning("Check the handler.")}\n${message("Found it.")}`);

    expect(insert).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith({
      items: [{ kind: "reasoning", observedAt: 3_000, text: "Check the handler." }],
      startedAt: 1_000,
      truncated: false,
    });
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(7, expect.objectContaining({
      items: [
        { kind: "reasoning", observedAt: 3_000, text: "Check the handler." },
        { kind: "message", observedAt: 9_000, text: "Found it." },
      ],
    }));
    expect(final.items).toHaveLength(2);
  });

  it("writes an empty transcript when the harness finishes without output", async () => {
    const insert = vi.fn().mockResolvedValue(1);
    const recorder = createTranscriptRecorder({ harness: "codex", insert, now: () => 0, onError: vi.fn(), update: vi.fn() });
    await recorder.finish("");
    expect(insert).toHaveBeenCalledWith({ items: [], startedAt: 0, truncated: false });
  });

  it("reports a failed write and keeps recording", async () => {
    const onError = vi.fn();
    const insert = vi.fn().mockRejectedValueOnce(new Error("database down")).mockResolvedValue(2);
    const recorder = createTranscriptRecorder({ harness: "codex", insert, now: () => 0, onError, update: vi.fn() });
    await recorder.update(message("One"));
    await recorder.finish(message("One"));
    expect(onError).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledTimes(2);
  });
});

describe("watchHarnessEvents", () => {
  afterEach(() => vi.useRealTimers());

  it("reads on an interval, skips missing files, and stops promptly", async () => {
    vi.useFakeTimers();
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValue("events");
    const onEvents = vi.fn();
    const watcher = watchHarnessEvents({ intervalMs: 1_000, onEvents, read });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onEvents).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onEvents).toHaveBeenCalledWith("events");

    await watcher.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
