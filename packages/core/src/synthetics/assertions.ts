import type {
  SyntheticAssertion,
  SyntheticAssertionResult,
  SyntheticResponse,
  SyntheticRunStatus,
} from "./types.js";

// "2xx" and the like match a class of status codes.
const statusClass = /^([1-5])xx$/iu;

function numeric(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// "$.data.items[0].id", "data.items[0].id" or '$["a key"]' as path segments.
// Null when the path cannot be read.
export function jsonPathSegments(path: string): Array<string | number> | null {
  let rest = path.trim().replace(/^\$/u, "");
  const segments: Array<string | number> = [];
  while (rest) {
    const match =
      /^\[(\d+)\]/u.exec(rest) ??
      /^\["((?:[^"\\]|\\.)*)"\]/u.exec(rest) ??
      /^\.?([^.[\]]+)/u.exec(rest);
    if (!match) return null;
    const [whole, segment] = match;
    segments.push(whole.startsWith("[") && !whole.startsWith('["') ? Number(segment) : segment!.replace(/\\(.)/gu, "$1"));
    rest = rest.slice(whole.length);
  }
  return segments;
}

// The value at the path, or undefined when it is absent.
function readJsonPath(document: unknown, path: string): unknown {
  const segments = jsonPathSegments(path);
  if (!segments) return undefined;
  let current: unknown = document;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function equal(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const left = numeric(actual);
  const right = numeric(expected);
  return left !== null && right !== null && left === right;
}

function compare(op: SyntheticAssertion["op"], actual: string | null, expected: string): boolean {
  switch (op) {
    case "exists":
      return actual !== null;
    case "not_exists":
      return actual === null;
    case "eq":
      return actual !== null && equal(actual, expected);
    case "neq":
      return actual === null || !equal(actual, expected);
    case "contains":
      return actual !== null && actual.includes(expected);
    case "not_contains":
      return actual === null || !actual.includes(expected);
    case "lt":
    case "gt": {
      const left = actual === null ? null : numeric(actual);
      const right = numeric(expected);
      if (left === null || right === null) return false;
      return op === "lt" ? left < right : left > right;
    }
  }
}

function statusMatches(op: SyntheticAssertion["op"], statusCode: number, expected: string): boolean {
  const range = statusClass.exec(expected.trim());
  if (range && (op === "eq" || op === "neq")) {
    const inClass = Math.floor(statusCode / 100) === Number(range[1]);
    return op === "eq" ? inClass : !inClass;
  }
  return compare(op, String(statusCode), expected.trim());
}

const dayMs = 86_400_000;

// Each assertion against the response. Without a response every assertion
// fails, since there is nothing to check.
export function evaluateSyntheticAssertions(
  assertions: readonly SyntheticAssertion[],
  response: SyntheticResponse | null,
  durationMs: number,
  now: Date,
): SyntheticAssertionResult[] {
  let parsedBody: { value: unknown } | null | undefined;
  const json = () => {
    if (parsedBody === undefined && response) {
      try {
        parsedBody = { value: JSON.parse(response.body) as unknown };
      } catch {
        parsedBody = null;
      }
    }
    return parsedBody ?? null;
  };
  return assertions.map((assertion) => {
    if (!response) return { actual: null, assertion, passed: false };
    switch (assertion.kind) {
      case "status_code":
        return {
          actual: String(response.statusCode),
          assertion,
          passed: statusMatches(assertion.op, response.statusCode, assertion.value),
        };
      case "response_time": {
        const actual = String(Math.round(durationMs));
        return { actual, assertion, passed: compare(assertion.op, actual, assertion.value) };
      }
      case "header": {
        const actual = response.headers[(assertion.key ?? "").toLowerCase()] ?? null;
        return { actual, assertion, passed: compare(assertion.op, actual, assertion.value) };
      }
      case "body":
        // A body cut short can still contain the text, but cannot be shown
        // not to.
        return {
          actual: null,
          assertion,
          passed:
            assertion.op === "not_contains" && response.bodyTruncated
              ? false
              : compare(assertion.op, response.body, assertion.value),
        };
      case "json_path": {
        const document = json();
        const found = document ? readJsonPath(document.value, assertion.key ?? "") : undefined;
        const actual = found === undefined ? null : jsonText(found);
        return { actual, assertion, passed: compare(assertion.op, actual, assertion.value) };
      }
      case "certificate_expiry": {
        if (!response.certificateExpiresAt) return { actual: null, assertion, passed: false };
        const days = Math.floor((Date.parse(response.certificateExpiresAt) - now.getTime()) / dayMs);
        return { actual: String(days), assertion, passed: compare(assertion.op, String(days), assertion.value) };
      }
    }
  });
}

// Failed when the request failed or a critical assertion did not hold;
// degraded when only degraded assertions did not hold.
export function syntheticRunStatus(error: string | null, results: readonly SyntheticAssertionResult[]): SyntheticRunStatus {
  if (error) return "failed";
  const failing = results.filter((result) => !result.passed);
  if (failing.some((result) => result.assertion.severity === "critical")) return "failed";
  return failing.length > 0 ? "degraded" : "passed";
}

const opLabels: Record<SyntheticAssertion["op"], string> = {
  contains: "contains",
  eq: "is",
  exists: "exists",
  gt: "is above",
  lt: "is below",
  neq: "is not",
  not_contains: "does not contain",
  not_exists: "is absent",
};

// "Status code is 2xx", for the app and Slack.
export function describeSyntheticAssertion(assertion: SyntheticAssertion): string {
  const op = opLabels[assertion.op];
  const value = assertion.op === "exists" || assertion.op === "not_exists" ? "" : ` ${assertion.value}`;
  switch (assertion.kind) {
    case "status_code":
      return `Status code ${op}${value}`;
    case "response_time":
      return `Response time ${op}${value} ms`;
    case "header":
      return `Header ${assertion.key ?? ""} ${op}${value}`;
    case "body":
      return `Body ${op}${value}`;
    case "json_path":
      return `JSON ${assertion.key ?? ""} ${op}${value}`;
    case "certificate_expiry":
      return `Certificate expires in more than ${assertion.value} days`;
  }
}

// Why a run did not pass, in one line: the request error, or the first
// failed assertion, critical ones first.
export function syntheticFailureReason(
  result: Pick<{ assertions: SyntheticAssertionResult[]; error: string | null }, "assertions" | "error">,
): string | null {
  if (result.error) return result.error;
  const failed = result.assertions
    .filter((item) => !item.passed)
    .sort((a, b) => Number(b.assertion.severity === "critical") - Number(a.assertion.severity === "critical"))[0];
  if (!failed) return null;
  const actual = failed.actual === null ? "" : `, got ${failed.actual}`;
  return `Expected ${describeSyntheticAssertion(failed.assertion).replace(/^./u, (first) => first.toLowerCase())}${actual}`;
}
