import type { ScanRun } from "./scan-data";

export function scanDateLabel(
  startedAt: string,
  locale?: string,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(startedAt));
}

export function failureReasonWithFindings(
  status: ScanRun["status"],
  failureReason: string | null | undefined,
  findingsCount: number,
): string | null {
  if (status !== "failed" || findingsCount === 0) return null;
  return failureReason ?? "Scan failed.";
}
