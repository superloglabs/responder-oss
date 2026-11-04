import { describe, expect, it, vi } from "vitest";
import { ClaudeRoutineFireError, claudeRoutineTriggerId, fireClaudeRoutine } from "./claude-routines.js";

describe("claudeRoutineTriggerId", () => {
  it("reads the trigger ID from a Fire URL", () => {
    expect(claudeRoutineTriggerId("https://api.anthropic.com/v1/claude_code/routines/trig_01ABCdef/fire")).toBe("trig_01ABCdef");
    expect(claudeRoutineTriggerId(" https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire/ ")).toBe("trig_01ABC");
  });

  it("rejects URLs on other hosts or paths", () => {
    expect(claudeRoutineTriggerId("https://example.com/v1/claude_code/routines/trig_01ABC/fire")).toBeNull();
    expect(claudeRoutineTriggerId("http://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire")).toBeNull();
    expect(claudeRoutineTriggerId("https://api.anthropic.com.evil.test/v1/claude_code/routines/trig_01ABC/fire")).toBeNull();
    expect(claudeRoutineTriggerId("https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/../x/fire")).toBeNull();
    expect(claudeRoutineTriggerId("https://api.anthropic.com/v1/claude_code/routines/routine_01ABC/fire")).toBeNull();
  });
});

describe("fireClaudeRoutine", () => {
  const input = { text: "Alert fired", token: "sk-ant-oat01-secret", triggerId: "trig_01ABC" };

  it("posts the text with the routine's token and returns the session", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      claude_code_session_id: "session_01",
      claude_code_session_url: "https://claude.ai/code/session_01",
      type: "routine_fire",
    }));
    await expect(fireClaudeRoutine(input, fetchImpl)).resolves.toEqual({ sessionUrl: "https://claude.ai/code/session_01" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      "anthropic-version": "2023-06-01",
      authorization: "Bearer sk-ant-oat01-secret",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({ text: "Alert fired" });
  });

  it("drops a session URL outside claude.ai", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ claude_code_session_url: "javascript:alert(1)" }));
    await expect(fireClaudeRoutine(input, fetchImpl)).resolves.toEqual({ sessionUrl: null });
  });

  it("retries rate limits and server errors but not rejected tokens", async () => {
    const failure = (status: number) => vi.fn(async () => Response.json(
      { error: { message: "nope", type: "x" }, type: "error" }, { status },
    ));
    for (const status of [429, 500, 503]) {
      await expect(fireClaudeRoutine(input, failure(status))).rejects.toMatchObject({ retryable: true });
    }
    for (const status of [400, 401, 403, 404]) {
      await expect(fireClaudeRoutine(input, failure(status))).rejects.toMatchObject({ retryable: false });
    }
    await expect(fireClaudeRoutine(input, failure(401))).rejects.toThrow("The routine token was rejected: nope");
  });

  it("retries only network failures that happened before the request was sent", async () => {
    const refused = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    });
    await expect(fireClaudeRoutine(input, refused)).rejects.toMatchObject({ retryable: true });
    const timedOut = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const error = await fireClaudeRoutine(input, timedOut).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClaudeRoutineFireError);
    expect(error).toMatchObject({ message: "Anthropic did not answer in time", retryable: false });
  });
});
