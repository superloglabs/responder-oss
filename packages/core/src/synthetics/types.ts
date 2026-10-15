// Synthetic checks: HTTP requests the worker makes on a schedule for a
// workspace, with assertions on the response. Kept free of the validation
// library and Node APIs, so the app can use the types and helpers.

export const syntheticMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type SyntheticMethod = (typeof syntheticMethods)[number];

// How often a check can run.
export const syntheticIntervals = [60, 300, 900, 1_800, 3_600] as const;

export const syntheticAssertionKinds = [
  "status_code",
  "response_time",
  "header",
  "body",
  "json_path",
  "certificate_expiry",
] as const;
export type SyntheticAssertionKind = (typeof syntheticAssertionKinds)[number];

export const syntheticAssertionOps = [
  "eq",
  "neq",
  "lt",
  "gt",
  "contains",
  "not_contains",
  "exists",
  "not_exists",
] as const;
export type SyntheticAssertionOp = (typeof syntheticAssertionOps)[number];

// The comparisons each kind of assertion accepts.
export const syntheticAssertionOpsByKind: Record<SyntheticAssertionKind, readonly SyntheticAssertionOp[]> = {
  body: ["contains", "not_contains"],
  certificate_expiry: ["gt"],
  header: ["eq", "neq", "contains", "not_contains", "exists", "not_exists"],
  json_path: ["eq", "neq", "contains", "not_contains", "lt", "gt", "exists", "not_exists"],
  response_time: ["lt"],
  status_code: ["eq", "neq", "lt", "gt"],
};

// Critical assertions fail the run; degraded ones mark it degraded.
export type SyntheticAssertionSeverity = "critical" | "degraded";

export interface SyntheticAssertion {
  // The header name or JSON path, for the kinds that read one.
  key?: string;
  kind: SyntheticAssertionKind;
  op: SyntheticAssertionOp;
  severity: SyntheticAssertionSeverity;
  // Compared with the response. Unused by exists and not_exists.
  value: string;
}

export interface SyntheticHeader {
  name: string;
  // Secret values are stored encrypted and never returned; a saved secret
  // reads as an empty value.
  secret: boolean;
  value: string;
}

export interface SyntheticRequest {
  body: string | null;
  followRedirects: boolean;
  headers: SyntheticHeader[];
  method: SyntheticMethod;
  timeoutMs: number;
  url: string;
}

export type SyntheticRunStatus = "passed" | "degraded" | "failed";

// Where the time went, in milliseconds. Phases a request did not need, such
// as TLS for plain HTTP, are zero. Redirects add their hops' phases.
export interface SyntheticTimings {
  connectMs: number;
  dnsMs: number;
  downloadMs: number;
  firstByteMs: number;
  tlsMs: number;
}

export interface SyntheticResponse {
  // The start of the body, as text.
  body: string;
  bodyBytes: number;
  bodyTruncated: boolean;
  certificateExpiresAt: string | null;
  headers: Record<string, string>;
  redirects: number;
  statusCode: number;
  // The URL that answered, after redirects.
  url: string;
}

export interface SyntheticAssertionResult {
  // What the response had, when there was something to compare.
  actual: string | null;
  assertion: SyntheticAssertion;
  passed: boolean;
}

export interface SyntheticRunResult {
  assertions: SyntheticAssertionResult[];
  attempts: number;
  durationMs: number;
  error: string | null;
  // Null when no response arrived.
  response: SyntheticResponse | null;
  startedAt: string;
  status: SyntheticRunStatus;
  timings: SyntheticTimings;
}

export const emptyTimings: SyntheticTimings = { connectMs: 0, dnsMs: 0, downloadMs: 0, firstByteMs: 0, tlsMs: 0 };
