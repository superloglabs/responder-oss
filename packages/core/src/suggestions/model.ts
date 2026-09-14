import { z } from "zod";
import { codeChangeRemediationSchema } from "../investigations/report.js";

const sentenceSegmenter = new Intl.Segmenter("en", {
  granularity: "sentence",
});

function sentence(maxLength: number, description: string) {
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

export const suggestionSubmissionSchema = z.object({
  title: sentence(200, "One-sentence title for the observability improvement."),
  subtitle: sentence(
    500,
    "One non-repetitive sentence explaining the observability gap and its impact.",
  ),
  detail: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe(
      "Detailed Markdown explaining why the change helps, how to implement it, and how to validate it. Code snippets are allowed.",
    ),
  codeChange: codeChangeRemediationSchema
    .superRefine((change, context) => {
      change.changes.forEach((part, index) => {
        if (part.pullRequest) return;
        context.addIssue({
          code: "custom",
          message: "New code changes require agent-authored pull request content",
          path: ["changes", index, "pullRequest"],
        });
      });
    })
    .optional()
    .describe(
      "Optional complete code change using the same patch shape as an Issue code remediation.",
    ),
}).superRefine((suggestion, context) => {
  const normalizedTitle = suggestion.title.toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const normalizedSubtitle = suggestion.subtitle.toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (normalizedTitle === normalizedSubtitle) {
    context.addIssue({
      code: "custom",
      message: "Subtitle must add information beyond the title",
      path: ["subtitle"],
    });
  }
});

export type SuggestionSubmission = z.infer<typeof suggestionSubmissionSchema>;
export type SuggestionCodeChange = NonNullable<SuggestionSubmission["codeChange"]> & {
  id: string;
};
