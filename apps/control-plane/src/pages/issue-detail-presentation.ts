import type {
  IssueDetailResponse,
  IssueEvidence,
  IssuePullRequestActivity,
} from "../agents-api";
import {
  providerDisplayName,
  providerGlyphs,
  type ProviderGlyphId,
} from "../components/provider-glyphs";

type Investigation = IssueDetailResponse["investigations"][number];
type EvidenceSource = IssueEvidence["source"];
type RowStatus =
  | Investigation["status"]
  | IssueDetailResponse["pullRequestState"]["requests"][number]["status"]
  | IssueDetailResponse["linearTicketState"]["requests"][number]["status"];
type PullRequestStatus =
  IssueDetailResponse["pullRequestState"]["requests"][number]["status"];

/** Labels that read better here than the shared provider name. */
const evidenceSourceLabelOverrides: Partial<Record<EvidenceSource, string>> = {
  alert: "Alert",
  clickstack: "ClickStack",
  other: "Other",
};

/** "May 20, 2026 · 1:25 AM" — the identified-at stamp under the title. */
export function issueIdentifiedAt(value: string | null, locale?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date);
  return `${day} · ${time}`;
}

/** "May 20" — the trailing date on a linked row. */
export function issueRowDate(value: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

export function investigationCountLabel(count: number): string {
  if (count === 0) return "No linked investigations";
  if (count === 1) return "Seen in 1 investigation";
  return `Seen in ${count} investigations`;
}

export function relationshipLabel(
  relationship: Investigation["relationship"],
): string {
  return relationship === "new" ? "First identified" : "Recurrence";
}

/** Drives the colour of the status dot on an investigation row. */
export function investigationStatusTone(
  status: Investigation["status"],
): "pending" | "active" | "resolved" | "failed" {
  if (status === "resolved") return "resolved";
  if (status === "failed") return "failed";
  if (status === "investigating") return "active";
  return "pending";
}

/**
 * The accessible name of a row's status dot. Colour alone carries the status
 * visually, so the dot needs a label for anyone who cannot see it.
 */
export function rowStatusLabel(status: RowStatus): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

export function pullRequestStateLabel(status: PullRequestStatus): string {
  if (status === "created") return "Open";
  return rowStatusLabel(status);
}

function activityData(
  activity: IssuePullRequestActivity,
): Record<string, unknown> {
  return activity.event.data ?? {};
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface PullRequestActivityPresentation {
  detail: string | null;
  href: string | null;
  title: string;
  tone: "default" | "success" | "failed";
}

export type PullRequestActivityTimelineItem =
  | { activity: IssuePullRequestActivity; kind: "activity" }
  | {
      activities: IssuePullRequestActivity[];
      anchor: IssuePullRequestActivity;
      jobId: string;
      kind: "review";
    };

const groupedReviewActivityTypes = new Set<
  IssuePullRequestActivity["event"]["type"]
>([
  "review.job.queued",
  "review.session.started",
  "review.trace",
  "review.session.completed",
  "review.session.failed",
]);

export function groupPullRequestActivities(
  activities: IssuePullRequestActivity[],
): PullRequestActivityTimelineItem[] {
  const timeline: PullRequestActivityTimelineItem[] = [];
  const reviews = new Map<string, Extract<
    PullRequestActivityTimelineItem,
    { kind: "review" }
  >>();
  let latestReview: Extract<
    PullRequestActivityTimelineItem,
    { kind: "review" }
  > | null = null;

  for (const activity of activities) {
    const data = activityData(activity);
    if (groupedReviewActivityTypes.has(activity.event.type)) {
      const jobId: string = stringValue(data.jobId) ?? latestReview?.jobId ??
        `review-${activity.id}`;
      let review = reviews.get(jobId);
      if (!review) {
        review = {
          activities: [],
          anchor: activity,
          jobId,
          kind: "review",
        };
        reviews.set(jobId, review);
        timeline.push(review);
      }
      review.activities.push(activity);
      latestReview = review;
      continue;
    }
    if (activity.event.type === "review.threads.addressed" && latestReview) {
      latestReview.activities.push(activity);
      continue;
    }
    timeline.push({ activity, kind: "activity" });
  }
  return timeline;
}

export function pullRequestReviewActivityPresentation(
  activities: IssuePullRequestActivity[],
): PullRequestActivityPresentation & { traceCount: number } {
  const terminal = [...activities].reverse().find((activity) =>
    activity.event.type === "review.session.completed" ||
    activity.event.type === "review.session.failed",
  );
  const started = activities.some(
    (activity) => activity.event.type === "review.session.started",
  );
  const traceCount = activities.filter(
    (activity) => activity.event.type === "review.trace",
  ).length;
  if (terminal?.event.type === "review.session.failed") {
    return {
      detail: stringValue(activityData(terminal).error),
      href: null,
      title: "Review failed",
      tone: "failed",
      traceCount,
    };
  }
  if (terminal?.event.type === "review.session.completed") {
    return {
      detail: null,
      href: null,
      title: "Review ran",
      tone: "success",
      traceCount,
    };
  }
  return {
    detail: null,
    href: null,
    title: started ? "Review running" : "Review queued",
    tone: "default",
    traceCount,
  };
}

export function pullRequestActivityPresentation(
  activity: IssuePullRequestActivity,
  repositoryFullName: string | null,
): PullRequestActivityPresentation {
  const data = activityData(activity);
  switch (activity.event.type) {
    case "review.comment.received": {
      const author = stringValue(data.author);
      const body = stringValue(data.body);
      return {
        detail: body ? `“${body}”` : null,
        href: stringValue(data.url),
        title: `${author ? `@${author}` : "A reviewer"} commented`,
        tone: "default",
      };
    }
    case "review.job.queued":
      return {
        detail: "The review follow-up was added to the queue.",
        href: null,
        title: "Review queued",
        tone: "default",
      };
    case "review.session.started":
      return {
        detail: "Reviewing the latest feedback and pull request head.",
        href: null,
        title: "Review started",
        tone: "default",
      };
    case "review.trace": {
      const trace = record(data.event);
      const traceData = record(trace?.data);
      const traceType = stringValue(trace?.type);
      if (traceType === "actions.requested") {
        const actions = Array.isArray(traceData?.actions) ? traceData.actions : [];
        const toolNames = actions
          .map((action) => stringValue(record(action)?.toolName))
          .filter((name): name is string => Boolean(name));
        return {
          detail: null,
          href: null,
          title: toolNames.length > 0
            ? `Ran ${[...new Set(toolNames)].join(", ")}`
            : "Ran a review action",
          tone: "default",
        };
      }
      if (traceType === "action.result") {
        return {
          detail: null,
          href: null,
          title: traceData?.status === "failed" ? "Review action failed" : "Review action completed",
          tone: traceData?.status === "failed" ? "failed" : "default",
        };
      }
      if (traceType === "message.completed") {
        return {
          detail: stringValue(traceData?.message),
          href: null,
          title: "Review update",
          tone: "default",
        };
      }
      return {
        detail: null,
        href: null,
        title: traceType === "reasoning.completed" ? "Reviewed the feedback" : "Review progress",
        tone: "default",
      };
    }
    case "review.commit.pushed": {
      const sha = stringValue(data.sha);
      const files = Array.isArray(data.files) ? data.files.length : 0;
      return {
        detail: [
          stringValue(data.message),
          files > 0 ? `${files} changed ${files === 1 ? "file" : "files"}` : null,
        ].filter(Boolean).join(" · ") || null,
        href: repositoryFullName && sha
          ? `https://github.com/${repositoryFullName}/commit/${sha}`
          : null,
        title: "Committed",
        tone: "success",
      };
    }
    case "review.threads.addressed": {
      const count = numberValue(data.count) ?? 0;
      return {
        detail: `${count} review ${count === 1 ? "thread" : "threads"} replied to and resolved.`,
        href: null,
        title: "Review feedback addressed",
        tone: "success",
      };
    }
    case "review.session.completed":
      return {
        detail: null,
        href: null,
        title: "Review completed",
        tone: "success",
      };
    case "review.session.failed":
      return {
        detail: stringValue(data.error),
        href: null,
        title: "Review failed",
        tone: "failed",
      };
  }
}

export function pullRequestReviewIsActive(
  activities: IssuePullRequestActivity[] = [],
): boolean {
  const latestLifecycleEvent = [...activities]
    .reverse()
    .find((activity) =>
      [
        "review.job.queued",
        "review.session.started",
        "review.session.completed",
        "review.session.failed",
      ].includes(activity.event.type),
    );
  return latestLifecycleEvent?.event.type === "review.job.queued" ||
    latestLifecycleEvent?.event.type === "review.session.started";
}

export function evidenceSourceGlyph(
  source: EvidenceSource,
): ProviderGlyphId | null {
  return source in providerGlyphs ? (source as ProviderGlyphId) : null;
}

export function evidenceSourceLabel(source: EvidenceSource): string {
  return evidenceSourceLabelOverrides[source] ?? providerDisplayName(source);
}

/**
 * The source that carries the issue, used for the Source property. Picks the
 * most common one and falls back to the first on a tie so the value is stable.
 */
export function primaryEvidenceSource(
  evidence: IssueEvidence[],
): EvidenceSource | null {
  if (evidence.length === 0) return null;
  const counts = new Map<EvidenceSource, number>();
  for (const item of evidence) {
    counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  }
  let best = evidence[0].source;
  for (const item of evidence) {
    if ((counts.get(item.source) ?? 0) > (counts.get(best) ?? 0)) {
      best = item.source;
    }
  }
  return best;
}

/** The agent that first identified the issue, used for the Agent property. */
export function originatingAgentName(
  investigations: Investigation[],
): string | null {
  if (investigations.length === 0) return null;
  const first =
    investigations.find((investigation) => investigation.relationship === "new") ??
    [...investigations].sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    )[0];
  return first?.agentName ?? null;
}

/** Splits a stored description into the paragraphs the layout renders. */
export function issueParagraphs(description: string): string[] {
  return description
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}
