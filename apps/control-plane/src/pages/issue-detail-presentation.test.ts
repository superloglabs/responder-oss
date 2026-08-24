import { describe, expect, it } from "vitest";
import type { IssueDetailResponse, IssueEvidence } from "../agents-api";
import {
  evidenceSourceGlyph,
  rowStatusLabel,
  evidenceSourceLabel,
  investigationCountLabel,
  investigationStatusTone,
  issueIdentifiedAt,
  issueParagraphs,
  issueRowDate,
  originatingAgentName,
  primaryEvidenceSource,
  relationshipLabel,
} from "./issue-detail-presentation";

type Investigation = IssueDetailResponse["investigations"][number];

function evidence(source: IssueEvidence["source"]): IssueEvidence {
  return { source, title: "title", detail: "detail" };
}

function investigation(overrides: Partial<Investigation>): Investigation {
  return {
    id: "investigation-1",
    agentId: "agent-1",
    agentName: "Payments",
    title: "Investigation",
    status: "resolved",
    relationship: "recurrence",
    evidence: [],
    createdAt: "2026-05-20T01:25:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("issueIdentifiedAt", () => {
  it("joins the day and the time of day", () => {
    expect(issueIdentifiedAt("2026-05-20T13:25:00.000Z", "en-US")).toMatch(
      /^May \d{1,2}, 2026 · \d{1,2}:\d{2}\s?(AM|PM)$/,
    );
  });

  it("falls back to a dash when the issue has no timestamp", () => {
    expect(issueIdentifiedAt(null)).toBe("—");
  });
});

describe("issueRowDate", () => {
  it("drops the year so linked rows stay in their column", () => {
    expect(issueRowDate("2026-05-20T13:25:00.000Z", "en-US")).toBe("May 20");
  });
});

describe("investigationCountLabel", () => {
  it("reads naturally for none, one, and many", () => {
    expect(investigationCountLabel(0)).toBe("No linked investigations");
    expect(investigationCountLabel(1)).toBe("Seen in 1 investigation");
    expect(investigationCountLabel(4)).toBe("Seen in 4 investigations");
  });
});

describe("relationshipLabel", () => {
  it("names the first sighting and later ones", () => {
    expect(relationshipLabel("new")).toBe("First identified");
    expect(relationshipLabel("recurrence")).toBe("Recurrence");
  });
});

describe("investigationStatusTone", () => {
  it("maps every investigation status to a dot colour", () => {
    expect(investigationStatusTone("pending")).toBe("pending");
    expect(investigationStatusTone("investigating")).toBe("active");
    expect(investigationStatusTone("resolved")).toBe("resolved");
    expect(investigationStatusTone("failed")).toBe("failed");
  });
});

describe("evidenceSourceLabel", () => {
  it("uses the product names people recognise", () => {
    expect(evidenceSourceLabel("sentry")).toBe("Sentry");
    expect(evidenceSourceLabel("github")).toBe("GitHub");
    expect(evidenceSourceLabel("vercel")).toBe("Vercel");
  });

  it("shortens the names that would crowd the column", () => {
    expect(evidenceSourceLabel("clickstack")).toBe("ClickStack");
  });

  it("names the sources that have no provider behind them", () => {
    expect(evidenceSourceLabel("alert")).toBe("Alert");
    expect(evidenceSourceLabel("other")).toBe("Other");
  });
});

describe("evidenceSourceGlyph", () => {
  it("uses the provider logo when the source is a provider", () => {
    expect(evidenceSourceGlyph("sentry")).toBe("sentry");
    expect(evidenceSourceGlyph("aws")).toBe("aws");
    expect(evidenceSourceGlyph("langfuse")).toBe("langfuse");
  });

  it("has no logo for sources that are not providers", () => {
    expect(evidenceSourceGlyph("alert")).toBeNull();
    expect(evidenceSourceGlyph("other")).toBeNull();
  });
});

describe("primaryEvidenceSource", () => {
  it("returns nothing when there is no evidence", () => {
    expect(primaryEvidenceSource([])).toBeNull();
  });

  it("picks the source that appears most often", () => {
    expect(
      primaryEvidenceSource([
        evidence("github"),
        evidence("sentry"),
        evidence("sentry"),
      ]),
    ).toBe("sentry");
  });

  it("keeps the first source on a tie", () => {
    expect(
      primaryEvidenceSource([evidence("datadog"), evidence("sentry")]),
    ).toBe("datadog");
  });
});

describe("originatingAgentName", () => {
  it("returns nothing without investigations", () => {
    expect(originatingAgentName([])).toBeNull();
  });

  it("prefers the investigation that first identified the issue", () => {
    expect(
      originatingAgentName([
        investigation({ agentName: "Checkout web" }),
        investigation({ agentName: "Payments", relationship: "new" }),
      ]),
    ).toBe("Payments");
  });

  it("falls back to the earliest investigation", () => {
    expect(
      originatingAgentName([
        investigation({
          agentName: "Checkout web",
          createdAt: "2026-05-22T00:00:00.000Z",
        }),
        investigation({
          agentName: "Ingest pipeline",
          createdAt: "2026-05-20T00:00:00.000Z",
        }),
      ]),
    ).toBe("Ingest pipeline");
  });
});

describe("issueParagraphs", () => {
  it("splits on blank lines and trims the leftovers", () => {
    expect(issueParagraphs("First line.\n\n  Second line.  \n\n\n")).toEqual([
      "First line.",
      "Second line.",
    ]);
  });

  it("keeps single newlines inside a paragraph", () => {
    expect(issueParagraphs("One\ntwo")).toEqual(["One\ntwo"]);
  });
});

describe("rowStatusLabel", () => {
  it("names every investigation status", () => {
    expect(rowStatusLabel("pending")).toBe("Pending");
    expect(rowStatusLabel("investigating")).toBe("Investigating");
    expect(rowStatusLabel("resolved")).toBe("Resolved");
    expect(rowStatusLabel("failed")).toBe("Failed");
  });

  it("names every pull request and Linear ticket status", () => {
    expect(rowStatusLabel("queued")).toBe("Queued");
    expect(rowStatusLabel("creating")).toBe("Creating");
    expect(rowStatusLabel("created")).toBe("Created");
  });
});
