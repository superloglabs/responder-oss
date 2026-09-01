import { describe, expect, it } from "vitest";
import type {
  IssueDetailResponse,
  IssueEvidence,
  IssuePullRequestActivity,
} from "../agents-api";
import {
  evidenceSourceGlyph,
  groupPullRequestActivities,
  rowStatusLabel,
  evidenceSourceLabel,
  investigationCountLabel,
  investigationStatusTone,
  issueIdentifiedAt,
  issueParagraphs,
  issueRowDate,
  originatingAgentName,
  primaryEvidenceSource,
  pullRequestActivityPresentation,
  pullRequestReviewActivityPresentation,
  pullRequestReviewIsActive,
  pullRequestStateLabel,
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

function activity(
  type: IssuePullRequestActivity["event"]["type"],
  data?: Record<string, unknown>,
  id = 1,
): IssuePullRequestActivity {
  return {
    id,
    event: {
      ...(data ? { data } : {}),
      meta: { at: "2026-08-25T10:00:00.000Z" },
      type,
    },
    createdAt: "2026-08-25T10:00:00.000Z",
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
    expect(evidenceSourceGlyph("gcp")).toBe("gcp");
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
    expect(rowStatusLabel("merged")).toBe("Merged");
  });
});

describe("pullRequestStateLabel", () => {
  it("uses the GitHub-facing state after publication", () => {
    expect(pullRequestStateLabel("created")).toBe("Open");
    expect(pullRequestStateLabel("merged")).toBe("Merged");
  });
});

describe("pullRequestActivityPresentation", () => {
  it("presents an incoming comment as a single top-level event", () => {
    expect(
      pullRequestActivityPresentation(
        activity("review.comment.received", {
          author: "silver-bot",
          body: "Petals need to be silver.",
          line: 12,
          path: "src/flower.ts",
          url: "https://github.com/acme/app/pull/27#discussion_r1",
        }),
        "acme/app",
      ),
    ).toEqual({
      detail: "“Petals need to be silver.”",
      href: "https://github.com/acme/app/pull/27#discussion_r1",
      title: "@silver-bot commented",
      tone: "default",
    });
  });

  it("links a pushed commit to its repository", () => {
    expect(
      pullRequestActivityPresentation(
        activity("review.commit.pushed", {
          files: ["src/flower.ts"],
          message: "Use silver petals",
          sha: "abc123",
        }),
        "acme/app",
      ),
    ).toEqual({
      detail: "Use silver petals · 1 changed file",
      href: "https://github.com/acme/app/commit/abc123",
      title: "Committed",
      tone: "success",
    });
  });

  it("turns trace tool calls into compact activity labels", () => {
    expect(
      pullRequestActivityPresentation(
        activity("review.trace", {
          event: {
            type: "actions.requested",
            data: { actions: [{ toolName: "apply_patch" }] },
          },
        }),
        "acme/app",
      ).title,
    ).toBe("Ran apply_patch");
  });
});

describe("groupPullRequestActivities", () => {
  it("collapses review lifecycle and trace events between comment and commit", () => {
    const activities = [
      activity("review.comment.received", { body: "Use bronze." }, 1),
      activity("review.job.queued", { jobId: "job-1" }, 2),
      activity("review.session.started", { jobId: "job-1" }, 3),
      activity("review.trace", {
        event: { type: "message.completed", data: { message: "Inspecting." } },
        jobId: "job-1",
      }, 4),
      activity("review.commit.pushed", { sha: "abc123" }, 5),
      activity("review.threads.addressed", { count: 1 }, 6),
      activity("review.session.completed", { jobId: "job-1" }, 7),
    ];

    const timeline = groupPullRequestActivities(activities);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity",
      "review",
      "activity",
    ]);
    const review = timeline[1];
    expect(review?.kind).toBe("review");
    if (review?.kind !== "review") throw new Error("Expected review group");
    expect(review.activities.map((item) => item.event.type)).toEqual([
      "review.job.queued",
      "review.session.started",
      "review.trace",
      "review.threads.addressed",
      "review.session.completed",
    ]);
    expect(pullRequestReviewActivityPresentation(review.activities)).toEqual({
      detail: null,
      href: null,
      title: "Review ran",
      tone: "success",
      traceCount: 1,
    });
  });
});

describe("pullRequestReviewIsActive", () => {
  it("polls between queueing and a terminal review event", () => {
    expect(pullRequestReviewIsActive([activity("review.job.queued")])).toBe(true);
    expect(
      pullRequestReviewIsActive([
        activity("review.job.queued"),
        activity("review.session.started", undefined, 2),
      ]),
    ).toBe(true);
    expect(
      pullRequestReviewIsActive([
        activity("review.session.started"),
        activity("review.session.completed", undefined, 2),
      ]),
    ).toBe(false);
  });
});
