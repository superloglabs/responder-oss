import { describe, expect, it } from "vitest";
import {
  type ErrorCandidate,
  errorCandidateSettleMs,
  errorCandidateWindow,
  errorCandidateWindowMs,
  errorIssueTitle,
  groupErrorCandidates,
  nextErrorCandidateCursor,
  occurrenceTransition,
  zeroCandidateId,
} from "./error-issues.js";
import { fingerprintV1 } from "./fingerprint-v1.js";
import { previousFingerprint } from "./fingerprint.js";

const organizationId = "0b9f6b9e-2f4a-4c1e-9d2b-3f8a6c1d7e01";
const stack = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "    at loadInvoice (/var/task/apps/api/src/invoices.ts:40:12)",
  "    at handler (/var/task/apps/api/src/routes.ts:12:3)",
].join("\n");

function candidate(overrides: Partial<ErrorCandidate> = {}): ErrorCandidate {
  return {
    attrs: { "http.route": "/invoices/:id" },
    body: "",
    candidate_id: "6a0d1c1e-0000-4000-8000-000000000001",
    discovered_ms: "1793000000000",
    exception_message: "Cannot read properties of undefined (reading 'id')",
    exception_stacktrace: stack,
    exception_type: "TypeError",
    kind: "span",
    project_id: organizationId,
    resource_attrs: { "service.name": "api", "superlog.project_id": organizationId },
    seen_ms: "1793000000000",
    service: "api",
    severity: "",
    span_id: "b7ad6b7169203331",
    span_name: "GET /invoices/:id",
    trace_id: "0af7651916cd43dd8448eb211c80319c",
    ...overrides,
  };
}

describe("groupErrorCandidates", () => {
  it("titles a production React error by its message and keeps the minified one on the sample", () => {
    const minified =
      "Minified React error #418; visit https://react.dev/errors/418?args[]=HTML&args[]= for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
    const [issue] = groupErrorCandidates([
      candidate({ body: minified, exception_message: minified, exception_type: "Error", kind: "log" }),
    ]);

    expect(issue?.title).toMatch(/^Error: Hydration failed because the server rendered HTML didn't match the client\./u);
    expect(issue?.sample.attributes["exception.message.minified"]).toBe(minified);
  });

  it("groups a stackless React error log by its decoded body when the body wraps the message", () => {
    const minified = (args: string) =>
      `Minified React error #31; visit https://react.dev/errors/31?args[]=${args} for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`;
    const log = (args: string) => candidate({
      body: `Uncaught ${minified(args)}`,
      exception_message: minified(args),
      exception_stacktrace: "",
      exception_type: "Error",
      kind: "log",
    });
    const [issue] = groupErrorCandidates([log("object%20with%20keys%20%7Bid%7D")]);

    expect(issue?.sample.message).toMatch(/^Objects are not valid as a React child/u);
    expect(groupErrorCandidates([log("object%20with%20keys%20%7Bid%7D")])[0]?.fingerprint).toBe(
      groupErrorCandidates([candidate({
        body: "Uncaught Objects are not valid as a React child (found: object with keys {id}). If you meant to render a collection of children, use an array instead.",
        exception_message: "Objects are not valid as a React child (found: object with keys {id}). If you meant to render a collection of children, use an array instead.",
        exception_stacktrace: "",
        exception_type: "Error",
        kind: "log",
      })])[0]?.fingerprint,
    );
  });

  it("collapses occurrences of one fingerprint and keeps the newest as the sample", () => {
    const [issue, ...rest] = groupErrorCandidates([
      candidate({ seen_ms: "1793000000000", trace_id: "first" }),
      candidate({ seen_ms: "1793000060000", trace_id: "newest" }),
      candidate({ seen_ms: "1792999940000", trace_id: "oldest" }),
    ]);

    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      eventCount: 3,
      firstSeenAt: new Date(1792999940000),
      kind: "span",
      lastSeenAt: new Date(1793000060000),
      organizationId,
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      topFrame: "loadInvoice@apps/api/src/invoices.ts",
    });
    expect(issue?.sample.traceId).toBe("newest");
    expect(issue?.fingerprint).toMatch(/^v3:/);
  });

  it("carries each occurrence's previous fingerprint once", () => {
    const [issue] = groupErrorCandidates([
      candidate(),
      candidate({ exception_stacktrace: stack.replace("at handler", "at async handler") }),
      candidate(),
    ]);

    expect(issue?.eventCount).toBe(3);
    const async = stack.replace("at handler", "at async handler");
    expect(issue?.previousFingerprints).toEqual([
      previousFingerprint({ message: candidate().exception_message, stacktrace: stack, type: "TypeError" }),
      fingerprintV1({ message: candidate().exception_message, stacktrace: stack, type: "TypeError" }),
      fingerprintV1({ message: candidate().exception_message, stacktrace: async, type: "TypeError" }),
    ]);
  });

  it("keeps workspaces apart even for the same fingerprint", () => {
    const groups = groupErrorCandidates([
      candidate(),
      candidate({ project_id: "5c3e1f0a-8b7d-4e6c-a1f2-9d8e7c6b5a40" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.fingerprint).toBe(groups[1]?.fingerprint);
  });

  it("counts occurrences per UTC day", () => {
    const [issue] = groupErrorCandidates([
      candidate({ seen_ms: String(Date.parse("2026-10-21T23:59:00Z")) }),
      candidate({ seen_ms: String(Date.parse("2026-10-22T00:01:00Z")) }),
      candidate({ seen_ms: String(Date.parse("2026-10-22T08:00:00Z")) }),
    ]);

    expect(issue?.dailyCounts).toEqual({ "2026-10-21": 1, "2026-10-22": 2 });
  });

  it("counts occurrences per UTC hour", () => {
    const [issue] = groupErrorCandidates([
      candidate({ seen_ms: String(Date.parse("2026-10-22T07:59:59Z")) }),
      candidate({ seen_ms: String(Date.parse("2026-10-22T08:00:00Z")) }),
      candidate({ seen_ms: String(Date.parse("2026-10-22T08:59:00Z")) }),
    ]);

    expect(issue?.hourlyCounts).toEqual({ "2026-10-22T07:00:00.000Z": 1, "2026-10-22T08:00:00.000Z": 2 });
  });

  it("groups logs without a stack by their normalized body", () => {
    const log = (body: string) =>
      candidate({
        body,
        exception_message: "",
        exception_stacktrace: "",
        exception_type: "",
        kind: "log",
        severity: "ERROR",
      });
    const groups = groupErrorCandidates([
      log("payment 4411 failed for customer 9"),
      log("payment 4412 failed for customer 17"),
      log("refund failed"),
    ]);

    expect(groups.map((group) => group.eventCount)).toEqual([2, 1]);
    expect(groups[0]).toMatchObject({ exceptionType: "ERROR", title: "ERROR: payment 4412 failed for customer 17" });
  });

  it("drops the workspace attribute and NUL bytes from the sample", () => {
    const [issue] = groupErrorCandidates([candidate({ exception_message: `bad${String.fromCharCode(0)} input` })]);

    expect(issue?.sample.resourceAttributes).toEqual({ "service.name": "api" });
    expect(issue?.message).toBe("bad input");
  });
});

describe("errorIssueTitle", () => {
  it("uses the first line of the message, then the top frame", () => {
    expect(errorIssueTitle({ exceptionType: "Error", topFrame: "run@src/job.ts" }, "\nfirst line\nsecond")).toBe(
      "Error: first line",
    );
    expect(errorIssueTitle({ exceptionType: "Error", topFrame: "run@src/job.ts" }, null)).toBe("Error in run@src/job.ts");
    expect(errorIssueTitle({ exceptionType: "Error", topFrame: null }, "")).toBe("Error");
  });

  it("shortens long titles", () => {
    expect(errorIssueTitle({ exceptionType: "Error", topFrame: null }, "x".repeat(500))).toHaveLength(200);
  });
});

describe("occurrenceTransition", () => {
  const resolvedAt = new Date("2026-10-22T12:00:00Z");
  const after = new Date("2026-10-22T12:00:01Z");

  it("opens new issues, reopens resolved ones, and leaves silenced ones silent", () => {
    expect(occurrenceTransition(null, after)).toBe("new");
    expect(occurrenceTransition({ status: "resolved", statusChangedAt: resolvedAt }, after)).toBe("regressed");
    expect(occurrenceTransition({ status: "silenced", statusChangedAt: resolvedAt }, after)).toBe("silenced");
    expect(occurrenceTransition({ status: "open", statusChangedAt: null }, after)).toBe("seen");
  });

  it("does not reopen a resolved issue for occurrences from before it was resolved", () => {
    expect(occurrenceTransition({ status: "resolved", statusChangedAt: resolvedAt }, resolvedAt)).toBe("seen");
    expect(occurrenceTransition({ status: "resolved", statusChangedAt: null }, resolvedAt)).toBe("regressed");
  });
});

describe("error candidate cursor", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const settled = new Date(now.getTime() - errorCandidateSettleMs);

  it("starts a first pass at the settle time", () => {
    expect(errorCandidateWindow(null, now)).toEqual({
      cursor: { candidateId: zeroCandidateId, discoveredAt: settled },
      until: settled,
    });
  });

  it("reads a bounded window that stops at the settle time", () => {
    const behind = { candidateId: zeroCandidateId, discoveredAt: new Date(now.getTime() - 60 * 60_000) };
    expect(errorCandidateWindow(behind, now).until).toEqual(
      new Date(behind.discoveredAt.getTime() + errorCandidateWindowMs),
    );

    const recent = { candidateId: zeroCandidateId, discoveredAt: new Date(now.getTime() - 60_000) };
    expect(errorCandidateWindow(recent, now).until).toEqual(settled);
  });

  it("never moves the window end behind the cursor", () => {
    const ahead = { candidateId: zeroCandidateId, discoveredAt: new Date(now.getTime() - 1_000) };
    expect(errorCandidateWindow(ahead, now).until).toEqual(ahead.discoveredAt);
  });

  it("stops a full batch at its last row", () => {
    const window = errorCandidateWindow({ candidateId: zeroCandidateId, discoveredAt: new Date(0) }, now);
    const rows = [
      { candidate_id: "a", discovered_ms: "1000" },
      { candidate_id: "b", discovered_ms: "2000" },
    ];
    expect(nextErrorCandidateCursor(window, rows, 2)).toEqual({ candidateId: "b", discoveredAt: new Date(2000) });
  });

  it("moves a partial batch to the window end", () => {
    const window = errorCandidateWindow({ candidateId: zeroCandidateId, discoveredAt: new Date(0) }, now);
    expect(nextErrorCandidateCursor(window, [{ candidate_id: "a", discovered_ms: "1000" }], 2)).toEqual({
      candidateId: zeroCandidateId,
      discoveredAt: window.until,
    });
  });

  it("keeps the candidate ID when the window has not moved", () => {
    const cursor = { candidateId: "b", discoveredAt: settled };
    const window = errorCandidateWindow(cursor, now);
    expect(nextErrorCandidateCursor(window, [], 2)).toBe(cursor);
  });
});

describe("groupErrorCandidates with a Python traceback as the log body", () => {
  it("titles the issue with the exception and keeps the traceback as the stack", () => {
    const body = [
      "Traceback (most recent call last):",
      '  File "/srv/app/billing/totals.py", line 7, in compute_total',
      "TypeError: unsupported operand type(s)",
    ].join("\n");
    const [issue] = groupErrorCandidates([
      candidate({ body, exception_message: "", exception_stacktrace: "", exception_type: "", kind: "log", severity: "ERROR" }),
    ]);

    expect(issue).toMatchObject({
      exceptionType: "TypeError",
      title: "TypeError: unsupported operand type(s)",
      topFrame: "compute_total@app/billing/totals.py",
    });
    expect(issue?.sample.stacktrace).toBe(body);
  });
});

describe("groupErrorCandidates with a failed request log", () => {
  // A request log line below error level whose fields say the request
  // failed with a server error.
  function request(attrs: Record<string, string>, overrides: Partial<ErrorCandidate> = {}): ErrorCandidate {
    return candidate({
      attrs,
      body: JSON.stringify({ type: "rest", timestamp: "2026-11-16T10:13:10.536Z", token: "test-token-0001", ...attrs }),
      exception_message: "",
      exception_stacktrace: "",
      exception_type: "",
      kind: "log",
      severity: "",
      severity_number: 0,
      span_name: "",
      ...overrides,
    });
  }
  const bigquery = '{"type":{"code":500,"description":"Internal Server Error"},"message":"Error connecting to bigquery source","label":undefined}';

  it("makes one issue of requests that failed the same way, whatever the rest of the line says", () => {
    const groups = groupErrorCandidates([
      request({ code: "500", endpoint: "data", response: bigquery, qid: "q-0001", ip: "203.0.113.7" }),
      request({ code: "500", endpoint: "data", response: bigquery, qid: "q-0002", key: "00000000-0000-4000-8000-000000000001" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      eventCount: 2,
      exceptionType: "HTTP 500",
      frames: [],
      kind: "log",
      message: "HTTP 500 data: Error connecting to bigquery source",
      previousFingerprints: [],
      title: "HTTP 500 data: Error connecting to bigquery source",
      topFrame: null,
    });
    expect(groups[0]!.sample.attributes).toMatchObject({ endpoint: "data", qid: "q-0002" });
  });

  it("keeps routes, statuses, services, and error texts apart", () => {
    const fingerprints = groupErrorCandidates([
      request({ code: "500", endpoint: "data", response: bigquery }),
      request({ code: "500", endpoint: "data", response: "Internal Server Error" }),
      request({ code: "502", endpoint: "data", response: bigquery }),
      request({ code: "500", endpoint: "aichart", response: bigquery }),
      // Routes that are paths stay distinct.
      request({ code: "500", endpoint: "/query", response: bigquery }),
      request({ code: "500", endpoint: "/export", response: bigquery }),
      request({ code: "500", endpoint: "data", response: bigquery }, { service: "plugins" }),
    ]).map((group) => group.fingerprint);
    expect(new Set(fingerprints).size).toBe(7);
  });

  it("reads the standard attribute names and ignores the identifiers in a path", () => {
    const groups = groupErrorCandidates([
      request({ "http.response.status_code": "503", "url.path": "/users/4812/orders/550e8400-e29b-41d4-a716-446655440000?page=2", "error.message": "upstream timed out after 30000ms" }),
      request({ "http.status_code": "503", "http.target": "/users/77/orders/0b3a7c11-1111-4222-8333-944455556666", error: "upstream timed out after 12ms" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBe("HTTP 503 /users/<id>/orders/<id>: upstream timed out after 12ms");
  });

  it("finds the status among several fields that could hold it", () => {
    const [group] = groupErrorCandidates([request({ status: "error", code: "502", endpoint: "data" })]);
    expect(group?.title).toBe("HTTP 502 data");
  });

  it("finds the error text in a response body, or goes without one", () => {
    const title = (attrs: Record<string, string>) => groupErrorCandidates([request({ code: "500", endpoint: "data", ...attrs })])[0]!.title;
    expect(title({ response: '{\n  "type": {\n    "code": 500\n  },\n  "message": "An unexpected error occurred."\n}' })).toBe("HTTP 500 data: An unexpected error occurred.");
    expect(title({ response: '{"error":"Member was not in project"}' })).toBe("HTTP 500 data: Member was not in project");
    expect(title({ response: "Internal Server Error\nat handler" })).toBe("HTTP 500 data: Internal Server Error");
    expect(title({ response: '{\r\n  "type": "https://tools.ietf.org/html/rfc9110#section-15.6.1",\r\n  "title": "An error occurred while processing your request.",\r\n  "status": 500,\r\n  "detail": null\r\n}' }))
      .toBe("HTTP 500 data: An error occurred while processing your request.");
    expect(title({ response: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><html><body>504 Gateway Time-out</body></html>' })).toBe("HTTP 500 data");
    expect(title({ response: '{"error":null}' })).toBe("HTTP 500 data");
    // A plain message may start with a bracket.
    expect(title({ message: "[worker] upstream timed out" })).toBe("HTTP 500 data: [worker] upstream timed out");
    // A field that only says there was an error is passed over.
    expect(title({ error: "true", message: "upstream timed out" })).toBe("HTTP 500 data: upstream timed out");
    // Escapes in a JSON string are read, and only its first line is the text.
    expect(title({ response: '{"message":"caf\\u00e9 \\"closed\\"\\n    at handler (/app/routes.js:12:3)"}' })).toBe('HTTP 500 data: café "closed"');
    expect(title({})).toBe("HTTP 500 data");
  });

  it("leaves a line at error level to its own message", () => {
    const [group] = groupErrorCandidates([
      request({ code: "500", endpoint: "data" }, { body: "Query failed: connection reset", severity: "ERROR", severity_number: 17 }),
    ]);
    expect(group).toMatchObject({ exceptionType: "ERROR", title: "ERROR: Query failed: connection reset" });
    expect(group!.previousFingerprints).toHaveLength(2);
  });

  it("keeps a log that says it is an error only in its severity text", () => {
    const [group] = groupErrorCandidates([
      request({ code: "200", endpoint: "data" }, { body: "Query failed: connection reset", severity: "error", severity_number: 0 }),
    ]);
    expect(group).toMatchObject({ exceptionType: "error", title: "error: Query failed: connection reset" });
  });

  it("drops a line below error level that is not a failed request", () => {
    expect(groupErrorCandidates([
      // A client error, a status without a route, and a number that is not a status.
      request({ code: "404", endpoint: "data" }),
      request({ code: "500" }),
      request({ duration: "512", endpoint: "data" }),
      request({ code: "5000", endpoint: "data" }),
    ])).toEqual([]);
  });
});
