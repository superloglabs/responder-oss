import { z } from "zod";

export const scanConfigurationSchema = z
  .object({
    frequencyHours: z.union([z.literal(1), z.literal(6), z.null()]),
    slackChannelResourceId: z.uuid().nullable(),
    contextAccountIds: z.array(z.uuid()).max(20).default([]),
    contextResourceIds: z.array(z.uuid()).max(100).default([]),
    repositoryIds: z.array(z.uuid()).max(100).default([]),
  })
  .superRefine((configuration, context) => {
    if (configuration.frequencyHours !== null && !configuration.slackChannelResourceId) {
      context.addIssue({
        code: "custom",
        message: "Choose a Slack channel before enabling scheduled scans",
        path: ["slackChannelResourceId"],
      });
    }
  });

export type ScanConfiguration = z.output<typeof scanConfigurationSchema>;

export const scanInstructions = [
  "Proactively inspect the connected context sources for active, user-impacting production problems.",
  "Focus on concrete evidence from the scan window and current state. Correlate evidence across sources when useful, and do not report stale, resolved, test, or speculative problems.",
  "Treat each distinct failure mechanism as one finding. Search existing issues before filing anything, and attach matching findings as recurrences instead of creating duplicates.",
  "This is an observation-only scan. Do not change source systems or publish code changes.",
].join("\n\n");
