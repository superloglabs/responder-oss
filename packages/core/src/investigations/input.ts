import { z } from "zod";
import type { InvestigationInput } from "../db/schema.js";

export const investigationRequestSchema = z.object({
  agentId: z.uuid(),
  provider: z.enum(["sentry", "datadog", "slack"]),
  externalEventId: z.string().min(1).max(512),
  title: z.string().min(1).max(500),
  body: z.string().min(1).max(100_000),
  sourceUrl: z.url().refine(
    (value) => ["http:", "https:"].includes(new URL(value).protocol),
    "Investigation source URLs must use HTTP or HTTPS",
  ).optional(),
  attributes: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});

export type InvestigationRequest = z.infer<typeof investigationRequestSchema>;

function stringAttribute(
  input: InvestigationInput,
  name: string,
): string | null {
  const value = input.attributes?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function awsAlarmPromptContext(input: InvestigationInput): string[] {
  if (
    input.provider !== "slack" ||
    stringAttribute(input, "slackAlertProvider") !== "aws"
  ) {
    return [];
  }
  const alarmName = stringAttribute(input, "awsAlarmName");
  const state = stringAttribute(input, "awsAlarmState");
  const region = stringAttribute(input, "awsAlarmRegion");
  const alarmUrl = stringAttribute(input, "awsAlarmUrl");
  return [
    "AWS alarm context:",
    alarmName ? `Alarm: ${alarmName}` : null,
    state ? `State: ${state}` : null,
    region ? `Region: ${region}` : null,
    alarmUrl ? `Alarm details: ${alarmUrl}` : null,
  ].filter((line): line is string => line !== null);
}

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
  const awsAlarmContext = awsAlarmPromptContext(input);
  return [
    `# ${input.provider} event`,
    "",
    `Title: ${input.title}`,
    input.sourceUrl ? `Source: ${input.sourceUrl}` : null,
    ...(awsAlarmContext.length > 0 ? ["", ...awsAlarmContext] : []),
    "",
    input.body,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
