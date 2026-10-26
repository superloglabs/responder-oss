import {
  abandonPendingAutomationRun,
  beginAutomationRun,
  findAutomationsForErrorIssue,
} from "@responder/core/db/automations";
import { findErrorIssue, type ErrorIssue } from "@responder/core/db/error-issues";
import { responderErrorIssueUrl } from "@responder/core/responder-urls";
import type { ErrorIssueChange } from "./error-issues.js";

export interface ErrorIssueAutomationDependencies {
  abandon: typeof abandonPendingAutomationRun;
  begin: typeof beginAutomationRun;
  find: typeof findAutomationsForErrorIssue;
  issue: typeof findErrorIssue;
  origin: string | null;
  queue: (run: { organizationId: string; runId: string }) => Promise<void>;
}

export const defaultErrorIssueAutomationDependencies: Omit<ErrorIssueAutomationDependencies, "queue"> = {
  abandon: abandonPendingAutomationRun,
  begin: beginAutomationRun,
  find: findAutomationsForErrorIssue,
  issue: findErrorIssue,
  origin: process.env.RESPONDER_APP_URL ?? process.env.BETTER_AUTH_URL ?? null,
};

// Runs one automation starts per pass. A deploy that breaks many things at
// once opens many issues; the rest are logged and skipped.
export const errorRunsPerAutomationPerPass = 10;

const maximumStacktraceLength = 8_000;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function attributeLines(attributes: Record<string, string>): string[] {
  return Object.entries(attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `- ${key}: ${value}`);
}

// The issue as the run's trigger message: what it is, how often it happens,
// and its newest occurrence with the stack trace.
export function errorIssueTriggerBody(
  issue: ErrorIssue,
  transition: ErrorIssueChange["transition"],
  url: string | null,
): string {
  const sample = issue.lastSample;
  const stacktrace = sample.stacktrace && sample.stacktrace.length > maximumStacktraceLength
    ? `${sample.stacktrace.slice(0, maximumStacktraceLength)}\n…`
    : sample.stacktrace;
  return [
    `# ${transition === "regressed" ? "Error regression" : "New error"}: ${issue.title}`,
    "",
    transition === "regressed"
      ? "This error issue was resolved and has occurred again."
      : "This error was seen for the first time.",
    "",
    `- Exception type: ${issue.exceptionType}`,
    `- Service: ${issue.service ?? "unknown"}`,
    `- Source: ${issue.kind === "span" ? "span exception event" : "error log"}`,
    `- Events: ${issue.eventCount.toLocaleString("en-US")}`,
    `- First seen: ${issue.firstSeenAt}`,
    `- Last seen: ${issue.lastSeenAt}`,
    `- Fingerprint: ${issue.fingerprint}`,
    ...(url ? [`- Issue: ${url}`] : []),
    ...(issue.frames.length > 0 ? ["", "## Grouped by these application frames", ...issue.frames.map((frame) => `- ${frame}`)] : []),
    "",
    `## Latest occurrence (${sample.seenAt})`,
    ...(sample.message ? ["", sample.message] : []),
    ...(stacktrace ? ["", "```", stacktrace, "```"] : []),
    ...(sample.traceId
      ? ["", `Trace ID: ${sample.traceId}${sample.spanId ? `, span ID: ${sample.spanId}` : ""}${sample.spanName ? ` (${sample.spanName})` : ""}`]
      : []),
    ...(Object.keys(sample.attributes).length > 0 ? ["", "Attributes:", ...attributeLines(sample.attributes)] : []),
    ...(Object.keys(sample.resourceAttributes).length > 0
      ? ["", "Resource attributes:", ...attributeLines(sample.resourceAttributes)]
      : []),
  ].join("\n");
}

// Starts the automations with an error trigger for each issue that opened or
// opened again. A new issue runs an automation once; a regression runs it once
// per time the issue reopens. Workspaces with paused notifications start
// none, and their issues are not new once notifications resume. Returns the
// number of runs started.
export async function startErrorIssueAutomations(
  changes: ErrorIssueChange[],
  dependencies: ErrorIssueAutomationDependencies,
): Promise<number> {
  const startedPerAutomation = new Map<string, number>();
  let started = 0;
  for (const change of changes) {
    if (change.notificationsPaused) continue;
    try {
      const issue = await dependencies.issue(change.organizationId, change.issueId);
      if (!issue) continue;
      const matches = await dependencies.find({
        eventType: change.transition === "regressed" ? "regression" : "new_issue",
        organizationId: change.organizationId,
        service: issue.service,
      });
      if (matches.length === 0) continue;
      const url = dependencies.origin ? responderErrorIssueUrl(issue.id, dependencies.origin) : null;
      const occurrence = change.transition === "regressed" ? `regressed:${issue.regressedAt ?? issue.lastSeenAt}` : "new";
      for (const match of matches) {
        const count = startedPerAutomation.get(match.automationId) ?? 0;
        if (count >= errorRunsPerAutomationPerPass) {
          console.warn(JSON.stringify({
            automationId: match.automationId,
            event: "error_issue_automation_skipped",
            issueId: issue.id,
            reason: "too_many_runs",
          }));
          continue;
        }
        try {
          const run = await dependencies.begin({
            automationId: match.automationId,
            trigger: {
              attributes: {
                eventCount: issue.eventCount,
                exceptionType: issue.exceptionType,
                fingerprint: issue.fingerprint,
                issueId: issue.id,
                kind: issue.kind,
                service: issue.service,
                traceId: issue.lastSample.traceId,
                transition: change.transition,
              },
              body: errorIssueTriggerBody(issue, change.transition, url),
              externalEventId: `error-issue:${issue.id}:${occurrence}`,
              provider: "errors",
              ...(url ? { sourceUrl: url } : {}),
              title: issue.title,
            },
          });
          if (!run.created) continue;
          try {
            await dependencies.queue({ organizationId: run.organizationId, runId: run.runId });
          } catch (error) {
            // Without a job the run would wait as pending forever.
            await dependencies.abandon(run.runId);
            throw error;
          }
          startedPerAutomation.set(match.automationId, count + 1);
          started += 1;
        } catch (error) {
          console.warn(JSON.stringify({
            automationId: match.automationId,
            error: errorText(error),
            event: "error_issue_automation_failed",
            issueId: issue.id,
          }));
        }
      }
    } catch (error) {
      console.warn(JSON.stringify({
        error: errorText(error),
        event: "error_issue_automations_failed",
        issueId: change.issueId,
      }));
    }
  }
  return started;
}
