import type { ProviderGlyphId } from "../components/provider-glyphs";

export type ScanRun = {
  activeIssues: number;
  duration: string;
  filedIssues: number;
  failureReason?: string | null;
  id: string;
  sources: number;
  startedAt: string;
  startedLabel: string;
  slackChannelName?: string | null;
  status: "completed" | "running" | "failed";
};

export type ScanFinding = {
  evidence: string;
  id: string;
  issueLabel: string;
  outcome: "existing" | "filed";
  severity: "SEV-1" | "SEV-2" | "SEV-3";
  source: string;
  title: string;
};

export const scanRuns: ScanRun[] = [
  {
    activeIssues: 9,
    duration: "4m 18s",
    filedIssues: 2,
    id: "scan-0914-0900",
    sources: 3,
    startedAt: "2026-09-14T09:00:00+02:00",
    startedLabel: "Today, 09:00",
    status: "completed",
  },
  {
    activeIssues: 7,
    duration: "3m 51s",
    filedIssues: 0,
    id: "scan-0914-0300",
    sources: 3,
    startedAt: "2026-09-14T03:00:00+02:00",
    startedLabel: "Today, 03:00",
    status: "completed",
  },
  {
    activeIssues: 8,
    duration: "4m 06s",
    filedIssues: 1,
    id: "scan-0913-2100",
    sources: 3,
    startedAt: "2026-09-13T21:00:00+02:00",
    startedLabel: "Yesterday, 21:00",
    status: "completed",
  },
  {
    activeIssues: 8,
    duration: "3m 44s",
    filedIssues: 0,
    id: "scan-0913-1500",
    sources: 3,
    startedAt: "2026-09-13T15:00:00+02:00",
    startedLabel: "Yesterday, 15:00",
    status: "completed",
  },
];

const findingTemplates: Array<Omit<ScanFinding, "outcome"> & { provider: Exclude<ProviderGlyphId, "google"> }> = [
  {
    evidence: "312 errors in responder-api after deploy 8c24d7",
    id: "finding-api-errors",
    issueLabel: "ISS-142",
    provider: "sentry",
    severity: "SEV-2",
    source: "Sentry",
    title: "Elevated API error rate after deployment",
  },
  {
    evidence: "p95 latency reached 8.4s across checkout requests",
    id: "finding-checkout-timeouts",
    issueLabel: "ISS-141",
    provider: "datadog",
    severity: "SEV-1",
    source: "Datadog",
    title: "Checkout requests are timing out",
  },
  {
    evidence: "Queue age remained above 14 minutes for 22 minutes",
    id: "finding-queue-latency",
    issueLabel: "ISS-139",
    provider: "datadog",
    severity: "SEV-2",
    source: "Datadog",
    title: "Worker queue latency is above threshold",
  },
  {
    evidence: "Authentication callback failures increased 18×",
    id: "finding-auth-callbacks",
    issueLabel: "ISS-137",
    provider: "sentry",
    severity: "SEV-2",
    source: "Sentry",
    title: "Authentication callbacks are failing",
  },
  {
    evidence: "Three production rollbacks started within 16 minutes",
    id: "finding-rollbacks",
    issueLabel: "ISS-134",
    provider: "github",
    severity: "SEV-3",
    source: "GitHub",
    title: "Production deployment is repeatedly rolling back",
  },
  {
    evidence: "Worker memory held above 88% for 31 minutes",
    id: "finding-memory",
    issueLabel: "ISS-132",
    provider: "datadog",
    severity: "SEV-3",
    source: "Datadog",
    title: "Worker memory pressure remains elevated",
  },
  {
    evidence: "Billing sync failed in four consecutive runs",
    id: "finding-scheduled-jobs",
    issueLabel: "ISS-129",
    provider: "sentry",
    severity: "SEV-3",
    source: "Sentry",
    title: "Scheduled billing jobs are failing",
  },
  {
    evidence: "Webhook retries increased 6× over the previous hour",
    id: "finding-webhooks",
    issueLabel: "ISS-126",
    provider: "datadog",
    severity: "SEV-3",
    source: "Datadog",
    title: "Webhook delivery retries are rising",
  },
  {
    evidence: "Release workflow has been blocked for 42 minutes",
    id: "finding-release-workflow",
    issueLabel: "ISS-123",
    provider: "github",
    severity: "SEV-3",
    source: "GitHub",
    title: "Production release workflow is blocked",
  },
];

export function findingsForScan(scan: ScanRun): ScanFinding[] {
  return findingTemplates.slice(0, scan.activeIssues).map((finding, index) => ({
    ...finding,
    outcome: index < scan.filedIssues ? "filed" : "existing",
  }));
}
