import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AutomationTrigger } from "./config.js";
import { isAutomationContextProvider } from "./context-providers.js";
import type { AutomationTemplateCategory, BuiltInAutomationTemplate } from "./templates.js";

// An automation template a model wrote for one workspace. It has the same
// shape as a built-in template, with a short reason it fits the workspace.
export interface SuggestedAutomationTemplate extends BuiltInAutomationTemplate {
  reason: string;
}

export const suggestedAutomationTemplateCount = 3;

// What the model sees about the workspace.
export interface AutomationSuggestionContext {
  automations: Array<{ description: string; name: string }>;
  connectedProviders: string[];
  // Earlier suggestions a member dismissed instead of using.
  dismissedSuggestions: string[];
  previousSuggestions: string[];
  recentIssues: Array<{ severity: string; title: string }>;
  repositories: string[];
  workspaceName: string;
}

// Providers that start runs. A suggestion can only use one that is connected.
const triggerProviders = new Set(["axiom", "devrev", "discord", "github", "honeycomb", "sentry", "signoz", "slack"]);

// The model's answer. Structured output accepts `anyOf` but not `oneOf` or
// numeric ranges, so the trigger is a plain union and lengths and ranges are
// checked after generation.
export const automationSuggestionOutputSchema = z.object({
  suggestions: z.array(z.object({
    category: z.enum(["support", "bug_triage", "scans"]),
    connectors: z.array(z.string()).describe("Providers the run reads from or writes to, such as github, sentry, or slack. Only connected providers."),
    description: z.string().describe("One sentence that says what the automation does and when, for a card in the template gallery."),
    name: z.string().describe("Two to five words in sentence case, starting with a verb."),
    prompt: z.string().describe("Instructions for the agent that runs the automation, one step per line."),
    reason: z.string().describe("One short sentence on why this fits the workspace, naming what you saw."),
    trigger: z.union([
      z.object({ eventMode: z.enum(["mentions", "every_message", "both"]), kind: z.literal("slack") }),
      z.object({ eventTypes: z.array(z.enum(["new_issue", "regression"])), kind: z.literal("sentry") }),
      z.object({ eventTypes: z.array(z.enum(["opened", "merged"])), kind: z.literal("github") }),
      z.object({ kind: z.literal("discord") }),
      z.object({ kind: z.literal("axiom") }),
      z.object({ kind: z.literal("devrev") }),
      z.object({ kind: z.literal("signoz") }),
      z.object({ kind: z.literal("honeycomb") }),
      z.object({
        frequency: z.enum(["hourly", "daily", "weekly"]),
        hour: z.number().describe("Local hour, 0 to 23."),
        kind: z.literal("schedule"),
        weekday: z.number().describe("Day for weekly runs, 0 is Sunday."),
      }),
    ]),
  })),
});

export type AutomationSuggestionOutput = z.infer<typeof automationSuggestionOutputSchema>;
type SuggestionTrigger = AutomationSuggestionOutput["suggestions"][number]["trigger"];

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1).trimEnd()}…` : trimmed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

// Triggers carry no connection, channels, projects, or repositories; the
// create page fills in the connection and the member picks the rest.
function templateTrigger(trigger: SuggestionTrigger): AutomationTrigger {
  switch (trigger.kind) {
    case "slack":
      return { channelIds: [], eventMode: trigger.eventMode, integrationAccountId: "", kind: "slack" };
    case "sentry":
      return { eventTypes: trigger.eventTypes.length ? [...new Set(trigger.eventTypes)] : ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: [] };
    case "github":
      return { eventTypes: trigger.eventTypes.length ? [...new Set(trigger.eventTypes)] : ["opened"], integrationAccountId: "", kind: "github", repositoryIds: [] };
    case "discord":
      return { channelIds: [], integrationAccountId: "", kind: "discord" };
    case "axiom":
    case "devrev":
    case "signoz":
    case "honeycomb":
      return { integrationAccountId: "", kind: trigger.kind };
    case "schedule":
      return { frequency: trigger.frequency, hour: clamp(trigger.hour, 0, 23), kind: "schedule", timezone: "UTC", weekday: clamp(trigger.weekday, 0, 6) };
  }
}

// Turns the model's answer into templates the create page can apply. Drops
// suggestions that need a provider the workspace has not connected or that
// repeat an existing automation or template name, and keeps the first
// `limit`, three by default.
export function suggestedAutomationTemplates(
  output: AutomationSuggestionOutput,
  input: { connectedProviders: string[]; limit?: number; takenNames: string[] },
  newId: () => string = randomUUID,
): SuggestedAutomationTemplate[] {
  const connected = new Set(input.connectedProviders);
  const taken = new Set(input.takenNames.map((name) => name.trim().toLowerCase()));
  const limit = input.limit ?? suggestedAutomationTemplateCount;
  const templates: SuggestedAutomationTemplate[] = [];
  if (limit <= 0) return templates;
  for (const suggestion of output.suggestions) {
    const { trigger } = suggestion;
    if (triggerProviders.has(trigger.kind) && !connected.has(trigger.kind)) continue;
    const name = clip(suggestion.name, 80);
    const prompt = clip(suggestion.prompt, 4_000);
    if (!name || !prompt || taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    const connectors = [...new Set(suggestion.connectors.map((provider) => provider.trim().toLowerCase()))]
      .filter((provider): provider is SuggestedAutomationTemplate["connectors"][number] =>
        connected.has(provider) && (provider === "github" || isAutomationContextProvider(provider)));
    templates.push({
      category: suggestion.category satisfies AutomationTemplateCategory,
      connectors,
      description: clip(suggestion.description, 240),
      id: newId(),
      name,
      prompt,
      reason: clip(suggestion.reason, 160),
      triggers: [templateTrigger(trigger)],
    });
    if (templates.length === limit) break;
  }
  return templates;
}

// Asks for two more than needed, since some answers are dropped.
export function automationSuggestionSystemPrompt(count = suggestedAutomationTemplateCount): string {
  return [
    "You suggest automations for a Responder workspace. Responder runs a coding agent with the workspace's repositories and connected tools when a trigger fires.",
    `Suggest ${count + 2} automations this team would set up today. Base each one on something specific in the workspace: a connected tool, a repository, or a recent issue. Prefer automations that save the team recurring work over generic ones.`,
    "Use only the connected providers for triggers and connectors. GitHub supplies repositories. A schedule trigger needs no provider.",
    "Do not repeat an existing automation, a built-in template, or an earlier suggestion. Do not suggest automations like the ones the team dismissed.",
    "Write the prompt as direct instructions to the agent: what to look at, what to do, where to report, and what to do when it finds nothing. Do not invent channel names, project names, or people.",
    "Write in plain, short sentences. No marketing language.",
  ].join("\n");
}

export function automationSuggestionPrompt(
  context: AutomationSuggestionContext,
  builtInTemplates: Array<Pick<BuiltInAutomationTemplate, "description" | "name">>,
): string {
  const list = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
  return [
    `Workspace: ${context.workspaceName}`,
    `Connected providers:\n${list(context.connectedProviders)}`,
    `Repositories:\n${list(context.repositories)}`,
    `Existing automations:\n${list(context.automations.map((automation) => automation.description ? `${automation.name}: ${automation.description}` : automation.name))}`,
    `Issues found in the last two weeks:\n${list(context.recentIssues.map((issue) => `${issue.title} (${issue.severity})`))}`,
    `Built-in templates:\n${list(builtInTemplates.map((template) => `${template.name}: ${template.description}`))}`,
    `Suggested before:\n${list(context.previousSuggestions)}`,
    `Dismissed by the team:\n${list(context.dismissedSuggestions)}`,
  ].join("\n\n");
}
