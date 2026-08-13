import { describe, expect, it } from "vitest";
import {
  investigationReportSubmissionSchema,
  renderIssueFixPrompt,
  renderInvestigationReportMarkdown,
} from "./report.js";

const evidence = {
  source: "github" as const,
  title: "Null dereference",
  detail: "The route reads careProfile.leaves when careProfile is null.",
  file: "app/api/plants/nullingia/route.ts",
  line: 9,
};

describe("investigation report", () => {
  it("renders a copy-ready issue remediation prompt", () => {
    const prompt = renderIssueFixPrompt({
      id: "07070707-0707-4707-8707-070707070707",
      title: "Null care profile dereference",
      description: "The Nullingia route reads a missing care profile.",
      severity: "SEV-2",
      remediation: "Protect the route.\n- Add a null check.",
      evidence: [evidence],
    });

    expect(prompt).toContain("Fix this issue in the relevant repository.");
    expect(prompt).toContain("app/api/plants/nullingia/route.ts:9");
    expect(prompt).toContain("Make the smallest safe change");
  });

  it("allows a report with no identified issues", () => {
    const parsed = investigationReportSubmissionSchema.safeParse({
      schemaVersion: 1,
      headline: "Alert did not represent a product defect",
      summary: "The monitor recovered before any failing request was observed.",
      issues: [],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects linking the same canonical issue twice", () => {
    const issueId = "07070707-0707-4707-8707-070707070707";
    const parsed = investigationReportSubmissionSchema.safeParse({
      schemaVersion: 1,
      headline: "Repeated null dereference",
      summary: "The same route failed again.",
      issues: [
        { resolution: "existing", issueId, evidence: [evidence] },
        { resolution: "existing", issueId, evidence: [evidence] },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("renders deterministic Slack markdown from structured data", () => {
    const issueId = "07070707-0707-4707-8707-070707070707";
    const markdown = renderInvestigationReportMarkdown(
      {
        schemaVersion: 1,
        headline: "Cart requests are failing",
        summary: "Nullingia fails deterministically.",
        issues: [
          {
            issueId,
            relationship: "recurrence",
            evidence: [evidence],
          },
        ],
      },
      [
        {
          id: issueId,
          title: "Null care profile dereference",
          description: "The Nullingia route reads a missing care profile.",
          severity: "SEV-2",
          remediation:
            "Prevent the route from reading a missing profile.\n- Add a null check before reading leaves.",
        },
      ],
    );

    expect(markdown).toContain("*SEV-2 — Null care profile dereference* · Recurrence");
    expect(markdown).toContain(
      "_Remediation:_ Prevent the route from reading a missing profile.\n  - Add a null check before reading leaves.",
    );
    expect(markdown).not.toContain("*Impact*");
    expect(markdown).not.toContain("*Details*");
  });
});
