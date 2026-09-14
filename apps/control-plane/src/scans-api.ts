import { apiErrorMessage, type IssueEvidence } from "./agents-api";
import type { ScanFinding, ScanRun } from "./pages/scan-data";
import { providerDisplayName } from "./components/provider-glyphs";

export interface ScanConfiguration {
  frequencyHours: 1 | 6 | null;
  slackChannelResourceId: string | null;
  contextAccountIds: string[];
  contextResourceIds: string[];
  repositoryIds: string[];
  nextRunAt?: string | null;
  channelName?: string | null;
}

interface ScanRunResponse {
  id: string;
  status: "pending" | "investigating" | "resolved" | "failed";
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  activeIssues: number;
  filedIssues: number;
  sourceCount: number;
  slackChannelName: string | null;
}

interface ScanDetailResponse extends Omit<ScanRunResponse, "activeIssues" | "filedIssues"> {
  reportMarkdown: string | null;
  findings: Array<{
    id: string;
    title: string;
    severity: "SEV-1" | "SEV-2" | "SEV-3";
    relationship: "new" | "recurrence";
    evidence: IssueEvidence[];
  }>;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function durationLabel(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return "—";
  const seconds = Math.max(
    0,
    Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1_000),
  );
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function toScanRun(run: ScanRunResponse): ScanRun {
  return {
    activeIssues: run.activeIssues,
    duration: durationLabel(run.startedAt, run.completedAt),
    failureReason: run.failureReason,
    filedIssues: run.filedIssues,
    id: run.id,
    slackChannelName: run.slackChannelName,
    sources: run.sourceCount,
    startedAt: run.startedAt ?? run.createdAt,
    startedLabel: dateLabel(run.startedAt ?? run.createdAt),
    status:
      run.status === "pending" || run.status === "investigating"
        ? "running"
        : run.status === "failed"
          ? "failed"
          : "completed",
  };
}

export async function fetchScans(): Promise<{
  configuration: ScanConfiguration;
  runs: ScanRun[];
}> {
  const response = await apiJson<{
    configuration: ScanConfiguration;
    runs: ScanRunResponse[];
  }>("/api/scans");
  return {
    configuration: response.configuration,
    runs: response.runs.map(toScanRun),
  };
}

export async function saveScanConfiguration(
  configuration: ScanConfiguration,
): Promise<ScanConfiguration> {
  const response = await apiJson<{ configuration: ScanConfiguration }>(
    "/api/scans/configuration",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configuration),
    },
  );
  return response.configuration;
}

export async function startScan(): Promise<string> {
  const response = await apiJson<{ investigationId: string }>("/api/scans/runs", {
    method: "POST",
  });
  return response.investigationId;
}

export async function fetchScan(scanId: string): Promise<{
  run: ScanRun;
  findings: ScanFinding[];
  reportMarkdown: string | null;
}> {
  const response = await apiJson<{ scan: ScanDetailResponse }>(
    `/api/scans/${encodeURIComponent(scanId)}`,
  );
  const findings = response.scan.findings.map((finding): ScanFinding => {
    const evidence = finding.evidence[0];
    return {
      evidence: evidence?.detail ?? "See the issue for supporting evidence.",
      id: finding.id,
      issueLabel: `Issue ${finding.id.slice(0, 8)}`,
      outcome: finding.relationship === "new" ? "filed" : "existing",
      severity: finding.severity,
      source: evidence?.source && evidence.source !== "alert" && evidence.source !== "other"
        ? providerDisplayName(evidence.source)
        : "Scan",
      title: finding.title,
    };
  });
  return {
    run: toScanRun({
      ...response.scan,
      activeIssues: findings.length,
      filedIssues: findings.filter((finding) => finding.outcome === "filed").length,
    }),
    findings,
    reportMarkdown: response.scan.reportMarkdown,
  };
}
