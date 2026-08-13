import { z } from "zod";
import type { InvestigationInput } from "../db/schema.js";

export const investigationRequestSchema = z.object({
  agentId: z.uuid(),
  provider: z.enum(["sentry", "datadog", "slack"]),
  externalEventId: z.string().min(1).max(512),
  title: z.string().min(1).max(500),
  body: z.string().min(1).max(100_000),
  sourceUrl: z.url().optional(),
  attributes: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});

export type InvestigationRequest = z.infer<typeof investigationRequestSchema>;

export function toInvestigationInput(request: InvestigationRequest): InvestigationInput {
  return {
    provider: request.provider,
    externalEventId: request.externalEventId,
    title: request.title,
    body: request.body,
    sourceUrl: request.sourceUrl,
    attributes: request.attributes,
  };
}

export function investigationPrompt(input: InvestigationInput): string {
  return [
    `# ${input.provider} event`,
    "",
    `Title: ${input.title}`,
    input.sourceUrl ? `Source: ${input.sourceUrl}` : null,
    "",
    input.body,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
