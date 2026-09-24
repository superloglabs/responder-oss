// Token counts for one model request. `inputTokens` excludes cached reads and
// cache writes so each field maps to exactly one price.
export interface AutomationModelUsage {
  cacheWriteTokens: number;
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

// The broker proxies three wire formats: OpenAI Responses, Anthropic
// Messages, and OpenAI-compatible chat completions.
export type AutomationModelWireFormat =
  | "chat_completions"
  | "messages"
  | "responses";

export interface AutomationModelUsageObserver {
  finish(): AutomationModelUsage | null;
  observe(chunk: Uint8Array): void;
}

const maximumBufferedBytes = 32 * 1024 * 1024;

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function openAIResponsesUsage(value: unknown): AutomationModelUsage | null {
  const usage = record(value);
  if (!usage) return null;
  const details = record(usage.input_tokens_details);
  const input = count(usage.input_tokens);
  const cached = Math.min(input, count(details?.cached_tokens));
  const cacheWrite = Math.min(input - cached, count(details?.cache_write_tokens));
  return {
    cacheWriteTokens: cacheWrite,
    cachedInputTokens: cached,
    inputTokens: input - cached - cacheWrite,
    outputTokens: count(usage.output_tokens),
  };
}

function chatCompletionsUsage(value: unknown): AutomationModelUsage | null {
  const usage = record(value);
  if (!usage) return null;
  const details = record(usage.prompt_tokens_details);
  const input = count(usage.prompt_tokens);
  const cached = Math.min(input, count(details?.cached_tokens));
  return {
    cacheWriteTokens: 0,
    cachedInputTokens: cached,
    inputTokens: input - cached,
    outputTokens: count(usage.completion_tokens),
  };
}

function anthropicMessagesUsage(value: unknown): AutomationModelUsage | null {
  const usage = record(value);
  if (!usage) return null;
  return {
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    cachedInputTokens: count(usage.cache_read_input_tokens),
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
  };
}

function mergeAnthropicUsage(
  current: AutomationModelUsage | null,
  update: AutomationModelUsage | null,
): AutomationModelUsage | null {
  if (!update) return current;
  if (!current) return update;
  // `message_delta` repeats cumulative counts; keep the largest value seen.
  return {
    cacheWriteTokens: Math.max(current.cacheWriteTokens, update.cacheWriteTokens),
    cachedInputTokens: Math.max(current.cachedInputTokens, update.cachedInputTokens),
    inputTokens: Math.max(current.inputTokens, update.inputTokens),
    outputTokens: Math.max(current.outputTokens, update.outputTokens),
  };
}

function usageFromEvent(
  format: AutomationModelWireFormat,
  event: Record<string, unknown>,
  current: AutomationModelUsage | null,
): AutomationModelUsage | null {
  if (format === "chat_completions") {
    // The final chunk carries usage when `stream_options.include_usage` is set.
    return chatCompletionsUsage(event.usage) ?? current;
  }
  if (format === "responses") {
    if (
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed"
    ) {
      return openAIResponsesUsage(record(event.response)?.usage) ?? current;
    }
    return current;
  }
  if (event.type === "message_start") {
    return mergeAnthropicUsage(
      current,
      anthropicMessagesUsage(record(event.message)?.usage),
    );
  }
  if (event.type === "message_delta") {
    return mergeAnthropicUsage(current, anthropicMessagesUsage(event.usage));
  }
  return current;
}

function usageFromBody(
  format: AutomationModelWireFormat,
  body: Record<string, unknown>,
): AutomationModelUsage | null {
  if (format === "chat_completions") return chatCompletionsUsage(body.usage);
  return format === "responses"
    ? openAIResponsesUsage(body.usage)
    : anthropicMessagesUsage(body.usage);
}

// Reads token usage from a provider response while it is forwarded unchanged.
// Server-sent events are parsed line by line; JSON bodies are parsed at the end.
export function createAutomationModelUsageObserver(
  format: AutomationModelWireFormat,
  contentType: string | null,
): AutomationModelUsageObserver {
  const streaming = contentType?.includes("text/event-stream") ?? false;
  const decoder = new TextDecoder();
  let pending = "";
  let bufferedBytes = 0;
  let overflowed = false;
  let usage: AutomationModelUsage | null = null;

  function processLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const event = record(JSON.parse(data));
      if (event) usage = usageFromEvent(format, event, usage);
    } catch {
      // Ignore malformed provider events; usage is read from valid ones.
    }
  }

  return {
    observe(chunk) {
      if (overflowed) return;
      pending += decoder.decode(chunk, { stream: true });
      if (!streaming) {
        bufferedBytes += chunk.byteLength;
        if (bufferedBytes > maximumBufferedBytes) {
          overflowed = true;
          pending = "";
        }
        return;
      }
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (pending.length > maximumBufferedBytes) {
        overflowed = true;
        pending = "";
      }
      for (const line of lines) processLine(line.replace(/\r$/u, ""));
    },
    finish() {
      if (overflowed) return usage;
      pending += decoder.decode();
      if (streaming) {
        for (const line of pending.split("\n")) {
          processLine(line.replace(/\r$/u, ""));
        }
        return usage;
      }
      try {
        const body = record(JSON.parse(pending));
        return body ? usageFromBody(format, body) : null;
      } catch {
        return null;
      }
    },
  };
}
