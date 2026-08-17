import { failIssuePullRequest } from "@responder/core/db/pull-requests";
import type { RemediationJob } from "@responder/core/jobs";
import {
  remediationRunDiagnostics,
  runRemediationAgent,
} from "./remediate.js";
import { safeInvestigationError } from "./investigate.js";
import { reportWorkerException } from "./monitoring.js";

interface RemediationJobDependencies {
  failRequest: typeof failIssuePullRequest;
  reportException: typeof reportWorkerException;
  runDiagnostics: typeof remediationRunDiagnostics;
  runAgent: typeof runRemediationAgent;
}

const defaultDependencies: RemediationJobDependencies = {
  failRequest: failIssuePullRequest,
  reportException: reportWorkerException,
  runDiagnostics: remediationRunDiagnostics,
  runAgent: runRemediationAgent,
};

export async function processRemediationJob(
  jobId: string,
  payload: RemediationJob,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: RemediationJobDependencies = defaultDependencies,
): Promise<{ requestId: string }> {
  let failure: unknown;
  let reportFailure = false;

  try {
    await dependencies.runAgent(payload, environment);
    failure = new Error(
      "Remediation finished without creating a pull request",
    );
  } catch (error) {
    failure = error;
    reportFailure = true;
  }

  const message = safeInvestigationError(failure, environment);
  let diagnostics: ReturnType<typeof remediationRunDiagnostics> = undefined;
  if (reportFailure) {
    try {
      diagnostics = dependencies.runDiagnostics(failure, environment);
    } catch {
      diagnostics = undefined;
    }
  }
  if (reportFailure) {
    console.error(
      JSON.stringify({
        ...(diagnostics ? { diagnostics } : {}),
        error: message,
        event: "remediation_job_failed",
        jobId,
        requestId: payload.remediationRequestId,
      }),
    );
  }

  const recording = Promise.resolve().then(() =>
    dependencies.failRequest(payload.remediationRequestId, message)
  );
  const reporting =
    reportFailure
      ? Promise.resolve().then(() =>
          dependencies.reportException(failure, {
            ...(diagnostics ? { diagnostics: { ...diagnostics } } : {}),
            investigationId: payload.investigationId,
            jobId,
            operation: "remediation",
            organizationId: payload.config.organizationId,
            requestId: payload.remediationRequestId,
          })
        )
      : Promise.resolve();
  const [recordingResult, reportingResult] = await Promise.allSettled([
    recording,
    reporting,
  ]);

  if (reportingResult.status === "rejected") {
    console.error(
      JSON.stringify({
        error: safeInvestigationError(reportingResult.reason, environment),
        event: "remediation_error_reporting_failed",
        jobId,
        requestId: payload.remediationRequestId,
      }),
    );
  }

  if (recordingResult.status === "rejected") {
    console.error(
      JSON.stringify({
        error: safeInvestigationError(recordingResult.reason, environment),
        event: "remediation_failure_recording_failed",
        jobId,
        requestId: payload.remediationRequestId,
      }),
    );
    throw new AggregateError(
      [
        failure,
        recordingResult.reason,
        ...(reportingResult.status === "rejected"
          ? [reportingResult.reason]
          : []),
      ],
      "Unable to record remediation failure",
    );
  }

  if (!reportFailure) {
    console.log(
      JSON.stringify({
        event: "remediation_job_complete",
        jobId,
        requestId: payload.remediationRequestId,
      }),
    );
  }

  return { requestId: payload.remediationRequestId };
}
