import { slackText } from "../telemetry/alert-text.js";

// How synthetic checks read in Slack.

export interface SyntheticMessageInput {
  checkName: string;
  checkUrl: string | null;
  method: string;
  url: string;
}

function durationLabel(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

// The message posted when a check starts failing.
export function syntheticFailingMessage(
  input: SyntheticMessageInput & { failures: number; location: string; reason: string },
): { markdown: string; text: string } {
  const link = input.checkUrl ? `\n\n[View check](${input.checkUrl})` : "";
  const runs = input.failures === 1 ? "The last run failed" : `The last ${input.failures} runs failed`;
  return {
    markdown:
      `:rotating_light: **${slackText(input.checkName)}** is failing.\n\n` +
      `\`${input.method}\` ${slackText(input.url)}\n` +
      `${runs} from ${slackText(input.location)}: ${slackText(input.reason)}${link}`,
    text: `${slackText(input.checkName)} is failing`,
  };
}

// The thread reply posted when a failing check passes again.
export function syntheticRecoveredMessage(
  input: SyntheticMessageInput & { durationMs: number; failingForMs: number; statusCode: number | null },
): { markdown: string; text: string } {
  const status = input.statusCode === null ? "" : ` It answered ${input.statusCode} in ${Math.round(input.durationMs)} ms.`;
  return {
    markdown: `:white_check_mark: **${slackText(input.checkName)}** recovered after ${durationLabel(input.failingForMs)}.${status}`,
    text: `${slackText(input.checkName)} recovered`,
  };
}
