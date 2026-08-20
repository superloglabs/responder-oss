import { z } from "zod";

export const issueSeveritySchema = z.enum(["SEV-1", "SEV-2", "SEV-3"]);

export const issueEvidenceSchema = z.object({
  source: z.enum([
    "alert",
    "aws",
    "datadog",
    "sentry",
    "clickstack",
    "upstash",
    "langfuse",
    "github",
    "slack",
    "vercel",
    "other",
  ]),
  title: z.string().trim().min(1).max(160),
  detail: z.string().trim().min(1).max(4_000),
  url: z
    .string()
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
      message: "Evidence URLs must use HTTP or HTTPS",
    })
    .optional(),
  file: z.string().trim().min(1).max(1_000).optional(),
  line: z.number().int().positive().optional(),
  toolCallId: z.string().trim().min(1).max(200).optional(),
});

export type IssueEvidence = z.infer<typeof issueEvidenceSchema>;

const newIssueSubmissionSchema = z.object({
  resolution: z.literal("new"),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Issue title."),
  description: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .describe("Issue description."),
  severity: issueSeveritySchema,
  remediation: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .describe("Suggested remediation."),
  evidence: z.array(issueEvidenceSchema).min(1).max(30),
});

const existingIssueSubmissionSchema = z.object({
  resolution: z.literal("existing"),
  issueId: z.string().uuid(),
  evidence: z.array(issueEvidenceSchema).min(1).max(30),
});

export const investigationReportSubmissionSchema = z.object({
  schemaVersion: z.literal(1),
  headline: z.string().trim().min(1).max(200).describe("Plain-text report headline."),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .describe("Investigation summary."),
  issues: z
    .array(
      z.discriminatedUnion("resolution", [
        newIssueSubmissionSchema,
        existingIssueSubmissionSchema,
      ]),
    )
    .max(20),
}).superRefine((report, context) => {
  const existingIds = new Set<string>();
  report.issues.forEach((issue, index) => {
    if (issue.resolution !== "existing") return;
    if (existingIds.has(issue.issueId)) {
      context.addIssue({
        code: "custom",
        message: "An existing issue can only be linked once",
        path: ["issues", index, "issueId"],
      });
    }
    existingIds.add(issue.issueId);
  });
});

export type InvestigationReportSubmission = z.infer<
  typeof investigationReportSubmissionSchema
>;

export interface InvestigationReportIssueReference {
  issueId: string;
  relationship: "new" | "recurrence";
  evidence: IssueEvidence[];
}

export interface StructuredInvestigationReport {
  schemaVersion: 1;
  headline: string;
  summary: string;
  issues: InvestigationReportIssueReference[];
}

export interface ReportIssue {
  id: string;
  title: string;
  description: string;
  severity: "SEV-1" | "SEV-2" | "SEV-3";
  remediation: string;
}

export function renderIssueFixPrompt(
  issue: ReportIssue & { evidence: IssueEvidence[] },
): string {
  const evidence = issue.evidence
    .map((item) => {
      const location = item.file
        ? ` (${item.file}${item.line ? `:${item.line}` : ""})`
        : "";
      return `- ${item.title}${location}: ${item.detail}`;
    })
    .join("\n");
  return [
    "Fix this issue in the relevant repository.",
    "",
    `Issue: ${issue.title}`,
    `Description: ${issue.description}`,
    `Severity: ${issue.severity}`,
    `Remediation: ${issue.remediation}`,
    ...(evidence ? ["", "Evidence:", evidence] : []),
    "",
    "Make the smallest safe change and verify it with relevant tests.",
  ].join("\n");
}

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderInvestigationReportMarkdown(
  report: StructuredInvestigationReport,
  issues: ReportIssue[],
): string {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const sections = [
    `*${escapeSlack(report.headline)}*`,
    escapeSlack(report.summary),
  ];

  if (report.issues.length === 0) {
    sections.push("*Issues*\nNo distinct issue was identified.");
  } else {
    const renderedIssues = report.issues.map((reference) => {
      const issue = issueById.get(reference.issueId);
      if (!issue) return null;
      const recurrence =
        reference.relationship === "recurrence" ? " · Recurrence" : "";
      return [
        `• *${issue.severity} — ${escapeSlack(issue.title)}*${recurrence}`,
        escapeSlack(issue.description),
        `  _Remediation:_ ${escapeSlack(issue.remediation).replaceAll("\n", "\n  ")}`,
      ].join("\n");
    });
    sections.push(
      `*Issues*\n${renderedIssues.filter((value): value is string => Boolean(value)).join("\n\n")}`,
    );
  }

  return sections.join("\n\n");
}
