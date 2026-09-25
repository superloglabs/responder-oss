import type { AutomationTranscriptEventData } from "@responder/core/automations/transcript";
import type { AutomationHarnessKind } from "./automation-harness.js";
import { parseAutomationTranscript } from "./automation-transcript.js";

export const harnessEventsPollIntervalMs = 1_500;

// Keeps one transcript event per turn current while the harness runs. Each
// item keeps the time the worker first saw it, which the run page uses for
// "Thought for 12s".
export function createTranscriptRecorder(input: {
  harness: AutomationHarnessKind;
  insert(data: Record<string, unknown>): Promise<number | undefined>;
  now(): number;
  onError(error: unknown): void;
  update(id: number, data: Record<string, unknown>): Promise<void>;
}) {
  const startedAt = input.now();
  const observedAt: number[] = [];
  let eventId: number | undefined;
  let written: string | undefined;
  // Writes run in order so an older read never replaces a newer one.
  let writes = Promise.resolve();

  function record(eventStream: string, final: boolean): Promise<AutomationTranscriptEventData> {
    const transcript = parseAutomationTranscript(input.harness, eventStream);
    const now = input.now();
    transcript.items.forEach((item, index) => {
      item.observedAt = observedAt[index] ??= now;
    });
    const data: AutomationTranscriptEventData = { ...transcript, startedAt };
    const serialized = JSON.stringify(data);
    writes = writes.then(async () => {
      if (serialized === written) return;
      if (!final && eventId === undefined && data.items.length === 0) return;
      if (eventId === undefined) eventId = await input.insert({ ...data });
      else await input.update(eventId, { ...data });
      written = serialized;
    }).catch(input.onError);
    return writes.then(() => data);
  }

  return {
    finish: (eventStream: string) => record(eventStream, true),
    update: (eventStream: string) => record(eventStream, false),
  };
}

// Reads the harness events file on an interval until stopped.
export function watchHarnessEvents(input: {
  intervalMs?: number;
  onEvents(eventStream: string): void;
  read(): Promise<string>;
}): { stop(): Promise<void> } {
  let stopped = false;
  let wake: (() => void) | undefined;
  const loop = (async () => {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, input.intervalMs ?? harnessEventsPollIntervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (stopped) break;
      // The file does not exist until the harness starts writing.
      const eventStream = await input.read().catch(() => null);
      if (eventStream !== null && !stopped) input.onEvents(eventStream);
    }
  })();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
