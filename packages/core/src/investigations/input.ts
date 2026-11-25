import { z } from "zod";
import type { InvestigationInput } from "../db/schema.js";
import { fenceUntrusted } from "../untrusted-text.js";

export const investigationRequestSchema = z.object({
  agentId: z.uuid(),
  provider: z.enum(["sentry", "datadog", "dash0", "slack", "linear", "scan"]),
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

// The event as the agent reads it. The title and body of an event from outside
// the workspace, such as an alert, an error report, or a review, are fenced as
// data. A request from a person in the workspace is not.
export function investigationPrompt(
  input: InvestigationInput,
  options: { outsideEvent?: boolean } = {},
): string {
  const awsAlarmContext = awsAlarmPromptContext(input);
  const outside = options.outsideEvent === true;
  return [
    `# ${input.provider} event`,
    "",
    outside ? fenceUntrusted("the event's title", input.title) : `Title: ${input.title}`,
    input.sourceUrl ? `Source: ${input.sourceUrl}` : null,
    ...(awsAlarmContext.length > 0 ? ["", ...awsAlarmContext] : []),
    "",
    outside ? fenceUntrusted("the event's description", input.body) : input.body,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
