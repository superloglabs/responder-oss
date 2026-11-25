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
  // Missing from older servers.
  jira?: SignalFindingJira;
}

export interface SignalJiraIssue {
  key: string;
  url: string;
}

export interface SignalFindingJira {
  // Whether members can file the finding in Jira.
  enabled: boolean;
  issue: SignalJiraIssue | null;
  // Why Signal could not file it automatically.
  error: string | null;
}

// button: members file findings with a button. automatic: Signal files
// every posted finding.
export type SignalJiraMode = "button" | "automatic";

export interface SignalJiraSettings {
  integrationAccountId: string;
  projectId: string;
  projectKey: string;
  issueTypeId: string;
  mode: SignalJiraMode;
}

export interface SignalUsageDay {
  date: string;
  total: number;
  accepted: number;
}

export type SignalCooldownHours = 6 | 24 | 72 | 168;
export type SignalRetentionDays = 30 | 60 | 90 | 365;

export interface SignalSlackChannel {
  integrationAccountId: string;
  channelId: string;
}

// Coding agents a finding's Slack message opens with its prompt filled in,
// and the Claude Code apps Open in Claude can start.
export const signalCodingAgents = ["claude", "codex", "conductor", "capy", "cmux", "replicas"] as const;
export type SignalCodingAgent = (typeof signalCodingAgents)[number];
export type SignalClaudeSurface = "terminal" | "desktop" | "web";

export interface SignalCodingAgents {
  // In button order. Agents get a button while they fit on one line with
  // the other buttons; the rest go in a menu at the end of it.
  agents: SignalCodingAgent[];
  claudeSurface: SignalClaudeSurface;
}

export interface SignalSettings {
  enabled: boolean;
  // True once Signal has been turned on, even if it is off now.
  setupComplete?: boolean;
  slack: SignalSlackChannel | null;
  repositoryIds: string[];
  // Findings below it stay on the Findings page: not posted, not billed.
  minimumSeverity: SignalSeverity;
  // Null allows the most the workspace may set, `limits.dailyInvestigationCap`.
  dailyInvestigationCap: number | null;
  dismissalCooldownHours: SignalCooldownHours;
  // Exact service names, or a prefix ending in "*".
  skippedServices: string[];
  notes: string;
  // Whether investigations search Slack for problems the team already
  // knows about, and the channels they search.
  slackScan: { enabled: boolean; channels: SignalSlackChannel[] };
  // Days Signal keeps findings, investigations, and the data it stored for
  // them. Null keeps them until the workspace is deleted.
  retentionDays: SignalRetentionDays | null;
  // The Jira project findings are filed in, or null when Jira is off.
  jira: SignalJiraSettings | null;
  codingAgents: SignalCodingAgents;
  // Whether a Replicas automation webhook is saved, which adds Send to
  // Replicas to findings in Slack. The URL itself is never sent back.
  replicas: { connected: boolean };
  // Whether a Discord channel webhook is saved. Findings are posted to it,
  // and to the Slack channel when one is chosen too. The URL itself is
  // never sent back.
  discord: { connected: boolean };
  // Why Slack or Discord refuses Signal's posts, or null while posts go
  // through. Findings waiting to be posted expire a day after they were made.
  delivery: SignalDeliveryProblem | null;
  limits: { dailyInvestigationCap: number };
}

export interface SignalDeliveryProblem {
  problem: "not_in_channel" | "channel_gone" | "access_revoked" | "disconnected" | "discord_webhook_gone";
  since: string;
  waiting: number;
  firstExpiresAt: string | null;
}

export interface SignalPlan {
  id: string;
  name: string;
  price: number;
  included: number;
  // Dollars per finding past the included ones. Null when the included
  // findings are a cap.
  overagePrice: number | null;
  // Whether the workspace can invite teammates on this plan.
  includesTeammates: boolean;
}

export interface SignalBilling {
  // False where the deployment does not bill, such as local development.
  enabled: boolean;
  plan: { id: string; name: string; price: number; cancelsAtPeriodEnd: boolean } | null;
  included: number;
  // Whether findings past `included` are billed instead of stopping Signal.
  overageAllowed: boolean;
  used: number;
  remaining: number;
  // Milliseconds since the epoch.
  resetsAt: number | null;
  plans: SignalPlan[];
  // Whether the workspace may choose how long Signal keeps its data: on
  // Team, or where the deployment does not bill.
  includesRetention?: boolean;
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

// Files the finding in Jira, or returns the issue already filed for it.
export function fileFindingInJira(id: string) {
  return signalJson<{ issue: SignalJiraIssue; created: boolean }>(`/findings/${encodeURIComponent(id)}/jira`, { method: "POST" });
}

export interface SignalJiraProject { id: string; key: string; name: string }
export interface SignalJiraIssueType { id: string; name: string }

export async function fetchJiraProjects(integrationAccountId: string) {
  const query = new URLSearchParams({ integrationAccountId });
  return (await signalJson<{ projects: SignalJiraProject[] }>(`/jira/projects?${query}`)).projects;
}

export async function fetchJiraIssueTypes(integrationAccountId: string, projectId: string) {
  const query = new URLSearchParams({ integrationAccountId });
  return (await signalJson<{ issueTypes: SignalJiraIssueType[] }>(
    `/jira/projects/${encodeURIComponent(projectId)}/issue-types?${query}`,
  )).issueTypes;
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
    slackScan: settings.slackScan ?? { enabled: false, channels: [] },
    retentionDays: settings.retentionDays ?? null,
    jira: settings.jira ?? null,
    codingAgents: settings.codingAgents ?? { agents: ["claude", "codex"], claudeSurface: "terminal" },
    replicas: settings.replicas ?? { connected: false },
    discord: settings.discord ?? { connected: false },
    delivery: settings.delivery ?? null,
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
    slackScan: settings.slackScan,
    retentionDays: settings.retentionDays,
    jira: settings.jira,
    codingAgents: settings.codingAgents,
  };
}

export async function fetchSignalSettings() {
  return withSettingsDefaults(await signalJson<SignalSettings>("/settings"));
}

export async function saveSignalSettings(settings: SignalSettings) {
  return withSettingsDefaults(await signalJson<SignalSettings>("/settings", jsonBody("PUT", settingsBody(settings))));
}

// Posts a message with the buttons findings get to the findings channel.
export async function sendSignalTestMessage() {
  return signalJson<{ channelId: string }>("/settings/test-message", { method: "POST" });
}

// Saves the webhook URL of a Replicas automation, or removes it with null.
export async function saveReplicasWebhook(webhookUrl: string | null) {
  return withSettingsDefaults(await signalJson<SignalSettings>("/settings/replicas", jsonBody("PUT", { webhookUrl })));
}

// Why a Discord webhook was not saved. refused: Discord rejected the test
// message. unavailable: Discord did not answer, so the URL may be fine.
export type DiscordSaveErrorCode = "invalid_url" | "refused" | "unavailable" | "last_destination" | "failed";

export class DiscordSaveError extends Error {
  constructor(message: string, readonly code: DiscordSaveErrorCode) {
    super(message);
    this.name = "DiscordSaveError";
  }
}

const discordHosts = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);
const discordWebhookPath = /^\/api(?:\/v\d{1,2})?\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,100}\/?$/u;

// What is wrong with a pasted Discord webhook URL before it is sent, or
// null when it has the form Signal accepts. The server checks it again.
export function discordWebhookUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Paste a Discord webhook URL; it starts with https://discord.com/api/webhooks/.";
  }
  if (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) {
    return "This is a Slack link. Paste a Discord webhook URL; it starts with https://discord.com/api/webhooks/.";
  }
  if (discordHosts.has(url.hostname) && url.pathname.startsWith("/channels/")) {
    return "This is a link to a Discord channel. Paste the channel's webhook URL; it starts with https://discord.com/api/webhooks/.";
  }
  const valid = url.protocol === "https:" && discordHosts.has(url.hostname) && url.port === "" &&
    url.username === "" && url.password === "" && url.search === "" && url.hash === "" &&
    discordWebhookPath.test(url.pathname);
  return valid ? null : "Paste a Discord webhook URL; it starts with https://discord.com/api/webhooks/.";
}

// Saves the webhook URL of a Discord channel, or removes it with null.
// Signal posts a short message to the channel to check the URL first.
export async function saveDiscordWebhook(webhookUrl: string | null) {
  let response: Response;
  try {
    response = await fetch("/api/signal/settings/discord", jsonBody("PUT", { webhookUrl }));
  } catch {
    throw new DiscordSaveError("Could not reach Superlog. Try again in a minute.", "unavailable");
  }
  const body = await response.json().catch(() => null) as (SignalSettings & { code?: string }) | null;
  if (!response.ok) {
    const code = body?.code;
    throw new DiscordSaveError(
      apiErrorMessage(body, response.status),
      code === "invalid_url" || code === "refused" || code === "unavailable" || code === "last_destination"
        ? code
        : response.status >= 500 ? "unavailable" : "failed",
    );
  }
  return withSettingsDefaults(body as SignalSettings);
}

// Where findings are posted: a Slack channel, a Discord webhook, or both.
export function findingsDestinationChosen(settings: Pick<SignalSettings, "slack" | "discord">) {
  return Boolean(settings.slack) || settings.discord.connected;
}

export function fetchSignalBilling() {
  return signalJson<SignalBilling>("/billing");
}

// Returns the checkout page, or no URL when the plan changed without one.
// Checkout returns to Signal's plan, or to the workspace's members after an
// upgrade to invite teammates.
export function startSignalCheckout(planId: string, returnTo?: "/settings/workspace") {
  return signalJson<{ url: string | null }>("/billing/checkout", jsonBody("POST", { planId, returnTo }));
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
