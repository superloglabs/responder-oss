import { type ErrorIssueStore, withErrorIssueStore } from "@responder/core/db/error-issues";
import { getTelemetryClient, type TelemetryClient } from "@responder/core/telemetry/client";
import {
  errorCandidates,
  errorCandidateWindow,
  errorIssueKinds,
  groupErrorCandidates,
  nextErrorCandidateCursor,
} from "@responder/core/telemetry/error-issues";

// Exceptions read per kind and pass.
const candidatesPerPass = 1_000;

// An issue that opened, or opened again, in a pass.
export type ErrorIssueChange = {
  issueId: string;
  organizationId: string;
  transition: "new" | "regressed";
};

export interface ErrorIssueDependencies {
  candidates: typeof errorCandidates;
  client: () => TelemetryClient | null;
  now: () => Date;
  withStore: <T>(pass: (store: ErrorIssueStore) => Promise<T>) => Promise<T | null>;
}

export const defaultErrorIssueDependencies: ErrorIssueDependencies = {
  candidates: errorCandidates,
  client: getTelemetryClient,
  now: () => new Date(),
  withStore: withErrorIssueStore,
};

// A cell whose ClickHouse does not have the exception projection yet.
function missingProjection(error: unknown): boolean {
  return typeof error === "object" && error !== null && "type" in error && error.type === "UNKNOWN_TABLE";
}
let missingProjectionReported = false;

// A write Postgres rejected for its data (SQLSTATE classes 22 and 23) fails
// the same way on every pass, so the pass skips it. Any other failure fails
// the pass, and the next one reads the same rows again.
function rejectedData(error: unknown): boolean {
  for (let current = error; typeof current === "object" && current !== null; current = (current as { cause?: unknown }).cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return /^2[23]/u.test(code);
  }
  return false;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

// Reads the exceptions that arrived since the last pass, groups them by
// fingerprint, and adds them to their issues. Returns the issues that opened
// or opened again, once the pass is saved. Does nothing in a cell without a
// telemetry store.
export async function ingestErrorIssues(
  dependencies: ErrorIssueDependencies = defaultErrorIssueDependencies,
): Promise<ErrorIssueChange[]> {
  const client = dependencies.client();
  if (!client) return [];
  const changes = await dependencies.withStore(async (store) => {
    const organizationIds = await store.organizationIds();
    const opened: ErrorIssueChange[] = [];
    for (const kind of errorIssueKinds) {
      const window = errorCandidateWindow(await store.cursor(kind), dependencies.now());
      const rows = await dependencies.candidates(client, {
        kind,
        limit: candidatesPerPass,
        organizationIds,
        window,
      });
      for (const occurrences of groupErrorCandidates(rows)) {
        try {
          const recorded = await store.record(occurrences);
          if (recorded.transition === "new" || recorded.transition === "regressed") {
            opened.push({
              issueId: recorded.issueId,
              organizationId: occurrences.organizationId,
              transition: recorded.transition,
            });
          }
        } catch (error) {
          if (!rejectedData(error)) throw error;
          // The cursor moves past the occurrences, so one bad row cannot stop
          // the rest.
          console.warn(JSON.stringify({
            error: errorText(error),
            event: "error_issue_record_failed",
            fingerprint: occurrences.fingerprint,
            organizationId: occurrences.organizationId,
          }));
        }
      }
      await store.saveCursor(kind, nextErrorCandidateCursor(window, rows, candidatesPerPass));
    }
    return opened;
  }).catch((error: unknown) => {
    if (!missingProjection(error)) throw error;
    if (!missingProjectionReported) {
      missingProjectionReported = true;
      console.warn(JSON.stringify({ error: errorText(error), event: "error_issue_projection_missing" }));
    }
    return null;
  });
  for (const change of changes ?? []) {
    console.log(JSON.stringify({ event: "error_issue_opened", ...change }));
  }
  return changes ?? [];
}
