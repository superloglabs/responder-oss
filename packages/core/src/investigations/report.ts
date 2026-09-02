import { z } from "zod";

export const issueSeveritySchema = z.enum(["SEV-1", "SEV-2", "SEV-3"]);

const sentenceSegmenter = new Intl.Segmenter("en", {
  granularity: "sentence",
});

function oneSentenceSchema(maxLength: number, description: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine(
      (value) => [...sentenceSegmenter.segment(value)].length <= 1,
      "Must contain at most one sentence",
    )
    .describe(description);
}

export const issueTimelineEntrySchema = z.object({
  title: oneSentenceSchema(160, "Short title for this timeline step."),
  description: oneSentenceSchema(
    500,
    "One-sentence description of what happened in this timeline step.",
  ),
});

export type IssueTimelineEntry = z.infer<typeof issueTimelineEntrySchema>;

export const issueEvidenceSchema = z.object({
  source: z.enum([
    "alert",
    "aws",
    "gcp",
    "datadog",
    "dash0",
    "posthog",
    "axiom",
    "sentry",
    "clickstack",
    "upstash",
    "langfuse",
    "supabase",
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

const remediationTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Short action-oriented remediation title.");

const remediationDescriptionSchema = oneSentenceSchema(
  4_000,
  "One-sentence human-readable explanation of the proposed remediation.",
);

const codeChangePartSchema = z.object({
  repository: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .describe("Attached repository that receives this change."),
  diff: z
    .string()
    .trim()
    .min(1)
    .max(40_000)
    .refine(
      (diff) =>
        /^diff --git /m.test(diff) &&
        /^--- /m.test(diff) &&
        /^\+\+\+ /m.test(diff) &&
        /^@@ /m.test(diff),
      "Must be a complete unified git diff",
    )
    .describe(
      "Complete unified git diff for this repository, including diff --git, ---/+++, and hunk headers.",
    ),
  pullRequest: z
    .object({
      title: z
        .string()
        .trim()
        .min(1)
        .max(240)
        .describe("Ready-for-review pull request title."),
      body: z
        .string()
        .trim()
        .min(1)
        .max(12_000)
        .describe(
          "Complete Markdown pull request body. Decide what context and validation results belong here.",
        ),
    })
    .optional()
    .describe(
      "Agent-authored pull request content. Required for newly proposed changes; optional only for remediations saved by older versions.",
    ),
});

const codeChangeRemediationSchema = z
  .object({
    type: z.literal("code_change"),
    title: remediationTitleSchema,
    description: remediationDescriptionSchema,
    changes: z
      .array(codeChangePartSchema)
      .min(1)
      .max(20)
      .describe(
        "Required code changes. One change produces one pull request; changes for the same repository should be combined.",
      ),
  })
  .superRefine((value, context) => {
    const repositories = value.changes
      .map((change) => change.repository)
      .filter((repository): repository is string => Boolean(repository));
    if (new Set(repositories).size !== repositories.length) {
      context.addIssue({
        code: "custom",
        message: "Each repository may appear only once in a code change plan",
        path: ["changes"],
      });
    }
  });

export const issueRemediationSubmissionSchema = z.discriminatedUnion("type", [
  codeChangeRemediationSchema,
  z.object({
    type: z.literal("external_action"),
    title: remediationTitleSchema,
    description: remediationDescriptionSchema,
    agentPrompt: z
      .string()
      .trim()
      .min(1)
      .max(8_000)
      .describe(
        "A self-contained prompt the user can give to an agent that has access to the external system.",
      ),
  }),
]);

export type IssueRemediationSubmission = z.infer<
  typeof issueRemediationSubmissionSchema
>;

export type IssueRemediation = IssueRemediationSubmission & { id: string };

export type CodeChangePart = z.infer<typeof codeChangePartSchema>;

export const authoredIssueRemediationsSchema = z
  .array(issueRemediationSubmissionSchema)
  .min(1)
  .max(10)
  .superRefine((remediations, context) => {
    remediations.forEach((remediation, remediationIndex) => {
      if (remediation.type !== "code_change") return;
      remediation.changes.forEach((change, changeIndex) => {
        if (change.pullRequest) return;
        context.addIssue({
          code: "custom",
          message: "New code changes require agent-authored pull request content",
          path: [remediationIndex, "changes", changeIndex, "pullRequest"],
        });
      });
    });
  })
  .describe(
    "Concrete remediation options with complete pull request content for every new code change.",
  );

export function codeChangeParts(
  remediation: Extract<IssueRemediationSubmission, { type: "code_change" }>,
): CodeChangePart[] {
  return remediation.changes;
}

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
  rootCause: oneSentenceSchema(
    500,
    "One sentence naming the code, environment, or infrastructure change that caused the issue.",
  ),
  timeline: z
    .array(issueTimelineEntrySchema)
    .min(1)
    .max(30)
    .describe("Ordered events that explain how the issue unfolded."),
  severity: issueSeveritySchema,
  remediations: authoredIssueRemediationsSchema.describe(
    "Concrete remediation options. Use code_change only after inspecting and editing the relevant files and running the checks you choose; use external_action for configuration, deployment, data, or other work outside the attached repositories.",
  ),
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
  rootCause: string;
  timeline: IssueTimelineEntry[];
  severity: "SEV-1" | "SEV-2" | "SEV-3";
  remediation: string;
  remediations?: IssueRemediation[];
}

export function remediationSummary(
  remediations: IssueRemediationSubmission[],
): string {
  return remediations
    .map((remediation) => `${remediation.title}: ${remediation.description}`)
    .join("\n\n");
}

export function renderIssueFixPrompt(
  issue: ReportIssue & { evidence: IssueEvidence[] },
  selectedRemediation?: IssueRemediationSubmission,
  targetRepository?: string,
): string {
  const timeline = issue.timeline ?? [];
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
    ...(issue.rootCause ? [`Root cause: ${issue.rootCause}`] : []),
    ...(timeline.length > 0
      ? [
          "Timeline:",
          ...timeline.map(
            (entry, index) =>
              `${index + 1}. ${entry.title}: ${entry.description}`,
          ),
        ]
      : []),
    `Severity: ${issue.severity}`,
    `Remediation: ${selectedRemediation?.title ?? "Recommended fix"}`,
    selectedRemediation?.description ?? issue.remediation,
    ...(selectedRemediation?.type === "code_change"
      ? [
          "",
          "Proposed changes:",
          ...codeChangeParts(selectedRemediation)
            .filter(
              (change) =>
                !targetRepository ||
                !change.repository ||
                change.repository === targetRepository,
            )
            .flatMap((change) => [
            change.repository ? `Repository: ${change.repository}` : "",
            "```diff",
            change.diff,
            "```",
            ]),
        ]
      : []),
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
      const timeline = issue.timeline ?? [];
      return [
        `• *${issue.severity} — ${escapeSlack(issue.title)}*${recurrence}`,
        escapeSlack(issue.description),
        ...(issue.rootCause
          ? [`  _Root cause:_ ${escapeSlack(issue.rootCause)}`]
          : []),
        ...(timeline.length > 0
          ? [
              "  _Timeline:_",
              ...timeline.map(
                (entry, index) =>
                  `  ${index + 1}. *${escapeSlack(entry.title)}* — ${escapeSlack(entry.description)}`,
              ),
            ]
          : []),
        `  _Remediation:_ ${escapeSlack(issue.remediation).replaceAll("\n", "\n  ")}`,
      ].join("\n");
    });
    sections.push(
      `*Issues*\n${renderedIssues.filter((value): value is string => Boolean(value)).join("\n\n")}`,
    );
  }

  return sections.join("\n\n");
}
