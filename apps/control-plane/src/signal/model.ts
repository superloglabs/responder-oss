import { apiErrorMessage } from "../agents-api";

export type SignalSeverity = "SEV-1" | "SEV-2" | "SEV-3";
export type SignalFindingStatus = "new" | "accepted" | "irrelevant";

export interface SignalFindingSummary {
  id: string;
  title: string;
  subtitle: string;
  severity: SignalSeverity;
  service: string | null;
  status: SignalFindingStatus;
  postedAt: string;
}

export interface SignalEvidence {
  kind: "logs" | "traces" | "metrics" | "code" | "provider";
  title: string;
  detail: string;
}

export interface SignalFindingDetail extends SignalFindingSummary {
  impact: string;
  affectedUsers: number | null;
  affectedRequests: number | null;
  rootCause: string;
  suggestedFix: string;
  evidence: SignalEvidence[];
  prompt: string;
}

export interface SignalUsageDay {
  date: string;
  total: number;
  accepted: number;
}

export type SignalCooldownHours = 6 | 24 | 72 | 168;

export interface SignalSettings {
  enabled: boolean;
  // True once Signal has been turned on, even if it is off now.
  setupComplete?: boolean;
  slack: { integrationAccountId: string; channelId: string } | null;
  repositoryIds: string[];
  // Findings below it stay on the Findings page: not posted, not billed.
  minimumSeverity: SignalSeverity;
  // Null allows the most the workspace may set, `limits.dailyInvestigationCap`.
  dailyInvestigationCap: number | null;
  dismissalCooldownHours: SignalCooldownHours;
  // Exact service names, or a prefix ending in "*".
  skippedServices: string[];
  notes: string;
  limits: { dailyInvestigationCap: number };
}

export interface SignalPlan {
  id: string;
  name: string;
  price: number;
  included: number;
}

export interface SignalBilling {
  // False where the deployment does not bill, such as local development.
  enabled: boolean;
  plan: { id: string; name: string; price: number; cancelsAtPeriodEnd: boolean } | null;
  included: number;
  used: number;
  remaining: number;
  // Milliseconds since the epoch.
  resetsAt: number | null;
  plans: SignalPlan[];
}

export const signalPeriods = [7, 14, 30] as const;
export type SignalPeriod = (typeof signalPeriods)[number];
export const findingsPageSize = 25;

async function signalJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/signal${path}`, init);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function fetchFindings(input: { days: SignalPeriod; search: string; offset: number }) {
  const query = new URLSearchParams({
    days: String(input.days),
    limit: String(findingsPageSize),
    offset: String(input.offset),
    ...(input.search.trim() ? { search: input.search.trim() } : {}),
  });
  return signalJson<{ total: number; findings: SignalFindingSummary[] }>(`/findings?${query}`);
}

export function fetchFinding(id: string) {
  return signalJson<SignalFindingDetail>(`/findings/${encodeURIComponent(id)}`);
}

export function setFindingStatus(id: string, status: SignalFindingStatus) {
  return signalJson<{ status: SignalFindingStatus }>(`/findings/${encodeURIComponent(id)}/status`, jsonBody("POST", { status }));
}

export function recordPromptCopied(id: string) {
  return signalJson<{ status: SignalFindingStatus }>(`/findings/${encodeURIComponent(id)}/copied`, { method: "POST" });
}

export function fetchUsage(days: SignalPeriod) {
  return signalJson<{ daily: SignalUsageDay[] }>(`/usage?days=${days}`);
}

// Older servers return only `enabled`, `slack`, and `repositoryIds`; the
// other fields take the server's defaults.
export function withSettingsDefaults(settings: Partial<SignalSettings> & Pick<SignalSettings, "enabled" | "slack" | "repositoryIds">): SignalSettings {
  return {
    ...settings,
    minimumSeverity: settings.minimumSeverity ?? "SEV-3",
    dailyInvestigationCap: settings.dailyInvestigationCap ?? null,
    dismissalCooldownHours: settings.dismissalCooldownHours ?? 24,
    skippedServices: settings.skippedServices ?? [],
    notes: settings.notes ?? "",
    limits: settings.limits ?? { dailyInvestigationCap: 50 },
  };
}

// What a save sends: everything but the read-only fields.
export function settingsBody(settings: SignalSettings) {
  return {
    enabled: settings.enabled,
    slack: settings.slack,
    repositoryIds: settings.repositoryIds,
    minimumSeverity: settings.minimumSeverity,
    dailyInvestigationCap: settings.dailyInvestigationCap,
    dismissalCooldownHours: settings.dismissalCooldownHours,
    skippedServices: settings.skippedServices,
    notes: settings.notes,
  };
}

export async function fetchSignalSettings() {
  return withSettingsDefaults(await signalJson<SignalSettings>("/settings"));
}

export async function saveSignalSettings(settings: SignalSettings) {
  return withSettingsDefaults(await signalJson<SignalSettings>("/settings", jsonBody("PUT", settingsBody(settings))));
}

export function fetchSignalBilling() {
  return signalJson<SignalBilling>("/billing");
}

// Returns the checkout page, or no URL when the plan changed without one.
export function startSignalCheckout(planId: string) {
  return signalJson<{ url: string | null }>("/billing/checkout", jsonBody("POST", { planId }));
}

export function openSignalBillingPortal() {
  return signalJson<{ url: string }>("/billing/portal", { method: "POST" });
}

// Signal can be turned on with a plan, with findings granted by hand, or
// where the deployment does not bill.
export function canTurnOnSignal(billing: SignalBilling) {
  return !billing.enabled || billing.plan !== null || billing.included > 0;
}

export function shortDate(date: Date) {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function utcDay(date: Date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// "Today", "Yesterday", or a short date, by UTC day.
export function dayLabel(date: Date, now: Date) {
  const days = Math.round((utcDay(now) - utcDay(date)) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : shortDate(date);
}

// How long ago a finding was posted: minutes and hours today, then the day.
export function foundLabel(date: Date, now: Date) {
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (utcDay(date) === utcDay(now)) {
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }
  return dayLabel(date, now);
}

// Findings in the order given, grouped by the UTC day they were posted.
export function groupFindingsByDay<T extends { postedAt: string }>(findings: readonly T[], now: Date) {
  const groups: Array<{ key: string; label: string; findings: T[] }> = [];
  for (const finding of findings) {
    const posted = new Date(finding.postedAt);
    const key = posted.toISOString().slice(0, 10);
    const group = groups.at(-1);
    if (group?.key === key) group.findings.push(finding);
    else groups.push({ key, label: dayLabel(posted, now), findings: [finding] });
  }
  return groups;
}

export function usageTotals(daily: readonly SignalUsageDay[]) {
  const total = daily.reduce((sum, day) => sum + day.total, 0);
  const accepted = daily.reduce((sum, day) => sum + day.accepted, 0);
  return { total, accepted, acceptedPercent: total ? accepted / total * 100 : 0 };
}

// A round axis maximum, so small counts do not fill the whole chart.
export function chartMax(values: readonly number[]) {
  const highest = Math.max(0, ...values);
  return highest <= 3 ? 3 : Math.ceil(highest / 3) * 3;
}

export function findingStatusLabel(status: SignalFindingStatus) {
  return status === "accepted" ? "Accepted" : status === "irrelevant" ? "Irrelevant" : "New";
}

// The OAuth start of a provider, coming back to the given setup page.
export function connectionStartUrl(connectUrl: string, returnTo: string) {
  const url = new URL(connectUrl, window.location.origin);
  url.searchParams.set("returnTo", returnTo);
  return `${url.pathname}${url.search}`;
}
