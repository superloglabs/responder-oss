// Claude Code routines started through their API trigger. A routine's Fire
// URL is always on api.anthropic.com, so only its trigger ID is stored and
// requests never go to a host the workspace chose.

const fireUrlPattern = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]{1,100})\/fire\/?$/u;
const fireTimeoutMs = 15_000;
// The endpoint accepts at most 65,536 characters of text.
export const claudeRoutineTextLimit = 60_000;

// The trigger ID in a routine's Fire URL, or null for any other URL.
export function claudeRoutineTriggerId(fireUrl: string): string | null {
  return fireUrlPattern.exec(fireUrl.trim())?.[1] ?? null;
}

export function claudeRoutineFireUrl(triggerId: string): string {
  return `https://api.anthropic.com/v1/claude_code/routines/${triggerId}/fire`;
}

export class ClaudeRoutineFireError extends Error {
  constructor(
    message: string,
    // Whether the routine certainly did not start, so trying again cannot
    // start a second session. The endpoint has no idempotency key.
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ClaudeRoutineFireError";
  }
}

const retryableStatuses = new Set([429, 500, 503]);
// Failures before the request reached Anthropic.
const unsentCodes = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function errorMessage(status: number, body: unknown): string {
  const message =
    body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object" && "message" in body.error
      ? String(body.error.message)
      : null;
  const meaning =
    status === 401 ? "The routine token was rejected"
    : status === 403 ? "The Claude account cannot use routine triggers"
    : status === 404 ? "The routine does not exist"
    : status === 429 ? "The routine's hourly limit was reached"
    : `Anthropic returned ${status}`;
  return message ? `${meaning}: ${message.slice(0, 300)}` : meaning;
}

// Starts a session of the routine with `text` as its run context. Returns the
// session's URL.
export async function fireClaudeRoutine(
  input: { text: string; token: string; triggerId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ sessionUrl: string | null }> {
  let response: Response;
  try {
    response = await fetchImpl(claudeRoutineFireUrl(input.triggerId), {
      body: JSON.stringify({ text: input.text.slice(0, claudeRoutineTextLimit) }),
      headers: {
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(fireTimeoutMs),
    });
  } catch (error) {
    const code = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause
      ? String(error.cause.code)
      : null;
    // A timeout may have started the routine, so it is not retried.
    throw new ClaudeRoutineFireError(
      error instanceof Error && error.name === "TimeoutError" ? "Anthropic did not answer in time" : "Unable to reach Anthropic",
      code !== null && unsentCodes.has(code),
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ClaudeRoutineFireError(errorMessage(response.status, body), retryableStatuses.has(response.status));
  const sessionUrl =
    body && typeof body === "object" && "claude_code_session_url" in body && typeof body.claude_code_session_url === "string"
      ? body.claude_code_session_url
      : null;
  // The URL is shown as a link, so only a claude.ai page is kept.
  return { sessionUrl: sessionUrl?.startsWith("https://claude.ai/") ? sessionUrl.slice(0, 500) : null };
}
