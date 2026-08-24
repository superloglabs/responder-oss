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
      rootCause: "A route change removed the null guard before reading the care profile.",
      timeline: [
        {
          title: "Request reached the route",
          description: "A request for a plant with no care profile reached the Nullingia route.",
        },
        {
          title: "Route read missing data",
          description: "The route read leaves from the absent care profile and threw an exception.",
        },
      ],
      severity: "SEV-2",
      remediation: "Protect the route.\n- Add a null check.",
      evidence: [evidence],
    });

    expect(prompt).toContain("Fix this issue in the relevant repository.");
    expect(prompt).toContain("app/api/plants/nullingia/route.ts:9");
    expect(prompt).toContain("Root cause: A route change removed the null guard");
    expect(prompt).toContain("1. Request reached the route");
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

  it("preserves Vercel as an evidence source", () => {
    const parsed = investigationReportSubmissionSchema.safeParse({
      schemaVersion: 1,
      headline: "Production deployment failed",
      summary: "The Vercel build exited during compilation.",
      issues: [{
        resolution: "new",
        title: "Vercel build failure",
        description: "The production deployment did not compile.",
        rootCause: "A source change introduced a TypeScript compile error.",
        timeline: [{
          title: "Deployment started",
          description: "Vercel started compiling the production deployment.",
        }],
        severity: "SEV-2",
        remediation: "Correct the compile error and redeploy.",
        evidence: [{
          source: "vercel",
          title: "Failed production deployment",
          detail: "The build log contains a TypeScript error.",
        }],
      }],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts a one-sentence root cause containing an abbreviation", () => {
    const parsed = investigationReportSubmissionSchema.safeParse({
      schemaVersion: 1,
      headline: "Production deployment failed",
      summary: "The build exited during compilation.",
      issues: [{
        resolution: "new",
        title: "Vercel build failure",
        description: "The production deployment did not compile.",
        rootCause: "A source change, e.g. the removed type guard, introduced a compile error.",
        timeline: [{
          title: "Deployment started",
          description: "Vercel started the build.",
        }],
        severity: "SEV-2",
        remediation: "Correct the compile error and redeploy.",
        evidence: [evidence],
      }],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a multi-sentence root cause", () => {
    const parsed = investigationReportSubmissionSchema.safeParse({
      schemaVersion: 1,
      headline: "Production deployment failed",
      summary: "The build exited during compilation.",
      issues: [{
        resolution: "new",
        title: "Vercel build failure",
        description: "The production deployment did not compile.",
        rootCause: "The code did not compile. A type was wrong.",
        timeline: [{
          title: "Deployment started",
          description: "Vercel started the build.",
        }],
        severity: "SEV-2",
        remediation: "Correct the compile error and redeploy.",
        evidence: [evidence],
      }],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a multi-sentence timeline entry", () => {
    const parsed = investigationReportSubmissionSchema.safeParse({
      schemaVersion: 1,
      headline: "Production deployment failed",
      summary: "The build exited during compilation.",
      issues: [{
        resolution: "new",
        title: "Vercel build failure",
        description: "The production deployment did not compile.",
        rootCause: "A source change introduced a TypeScript compile error.",
        timeline: [{
          title: "Deployment started. Compilation failed.",
          description: "Vercel started the build.",
        }],
        severity: "SEV-2",
        remediation: "Correct the compile error and redeploy.",
        evidence: [evidence],
      }],
    });

    expect(parsed.success).toBe(false);
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
          rootCause: "A route change removed the null guard before reading the care profile.",
          timeline: [
            {
              title: "Request reached the route",
              description: "A request with no care profile reached the route.",
            },
            {
              title: "Route threw",
              description: "The route read the missing care profile and threw an exception.",
            },
          ],
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
    expect(markdown).toContain(
      "_Root cause:_ A route change removed the null guard before reading the care profile.",
    );
    expect(markdown).toContain(
      "2. *Route threw* — The route read the missing care profile and threw an exception.",
    );
    expect(markdown).not.toContain("*Impact*");
    expect(markdown).not.toContain("*Details*");
  });
});
