import type { IssueDetailResponse, IssueEvidence } from "../agents-api";
import {
  providerDisplayName,
  providerGlyphs,
  type ProviderGlyphId,
} from "../components/provider-glyphs";

type Investigation = IssueDetailResponse["investigations"][number];
type EvidenceSource = IssueEvidence["source"];

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
