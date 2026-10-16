import { createGateway, generateText, Output, type LanguageModel } from "ai";
import {
  automationSuggestionOutputSchema,
  automationSuggestionPrompt,
  automationSuggestionSystemPrompt,
  suggestedAutomationTemplates,
} from "@responder/core/automations/suggested-templates";
import { builtInAutomationTemplates } from "@responder/core/automations/templates";
import {
  automationSuggestionDay,
  claimAutomationSuggestionDay,
  completeAutomationSuggestionDay,
  deleteOldAutomationSuggestions,
  failAutomationSuggestionDay,
  finishAutomationSuggestionRefill,
  getAutomationSuggestionContext,
  listOrganizationsDueForAutomationSuggestions,
  startAutomationSuggestionRefill,
} from "@responder/core/db/automation-template-suggestions";
import type { AutomationSuggestionContext, SuggestedAutomationTemplate } from "@responder/core/automations/suggested-templates";
import { modelCallTelemetry } from "./model-telemetry.js";

const defaultModel = "anthropic/claude-sonnet-5.5";
// Suggestions for a day are written from this UTC hour on, before the
// working day starts in Europe and the Americas.
const morningHourUtc = 5;
const organizationsPerPass = 20;
const activeWindowMs = 7 * 24 * 60 * 60 * 1_000;

export function automationSuggestionModel(environment: NodeJS.ProcessEnv = process.env): LanguageModel | null {
  const apiKey = environment.AI_GATEWAY_API_KEY?.trim();
  if (!apiKey) return null;
  return createGateway({ apiKey })(environment.AUTOMATION_SUGGESTION_MODEL?.trim() || defaultModel);
}

// Asks the model for `count` templates. The call uses Responder's AI Gateway
// key and is not charged to the organization's usage credit.
async function writeSuggestedTemplates(
  context: AutomationSuggestionContext,
  model: LanguageModel,
  count?: number,
): Promise<SuggestedAutomationTemplate[]> {
  const { output } = await generateText({
    abortSignal: AbortSignal.timeout(120_000),
    maxRetries: 1,
    model,
    output: Output.object({ schema: automationSuggestionOutputSchema }),
    prompt: automationSuggestionPrompt(context, builtInAutomationTemplates),
    system: automationSuggestionSystemPrompt(count),
    telemetry: modelCallTelemetry("automation-suggestions"),
  });
  return suggestedAutomationTemplates(output, {
    connectedProviders: context.connectedProviders,
    limit: count,
    takenNames: [
      ...context.automations.map((automation) => automation.name),
      ...builtInAutomationTemplates.map((template) => template.name),
      ...context.previousSuggestions,
    ],
  });
}

// Writes the day's suggested templates for one organization.
export async function generateAutomationSuggestions(input: {
  day: string;
  model: LanguageModel;
  now: Date;
  organizationId: string;
}): Promise<void> {
  try {
    const context = await getAutomationSuggestionContext(input);
    if (!context) return;
    const templates = await writeSuggestedTemplates(context, input.model);
    await completeAutomationSuggestionDay({ day: input.day, organizationId: input.organizationId, templates });
    console.log(JSON.stringify({
      count: templates.length,
      event: "automation_suggestions_generated",
      organizationId: input.organizationId,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Suggestion generation failed";
    await failAutomationSuggestionDay({ day: input.day, error: message, organizationId: input.organizationId });
    console.warn(JSON.stringify({
      error: message,
      event: "automation_suggestions_failed",
      organizationId: input.organizationId,
    }));
  }
}

// Writes replacements for suggestions a member used or dismissed. A failed
// call closes the request with no replacements; the member can refresh again.
export async function refillAutomationSuggestions(input: {
  generatedOn: string;
  model: LanguageModel | null;
  now?: Date;
  organizationId: string;
}): Promise<void> {
  const refill = await startAutomationSuggestionRefill(input);
  if (!refill) return;
  let templates: SuggestedAutomationTemplate[] = [];
  if (refill.missing > 0 && input.model) {
    try {
      const context = await getAutomationSuggestionContext({
        day: input.generatedOn,
        now: input.now ?? new Date(),
        organizationId: input.organizationId,
      });
      if (context) templates = await writeSuggestedTemplates(context, input.model, refill.missing);
    } catch (error) {
      console.warn(JSON.stringify({
        error: error instanceof Error ? error.message : "Suggestion refill failed",
        event: "automation_suggestions_refill_failed",
        organizationId: input.organizationId,
      }));
    }
  }
  await finishAutomationSuggestionRefill({
    generatedOn: input.generatedOn,
    organizationId: input.organizationId,
    requestedAt: refill.requestedAt,
    templates,
  });
  console.log(JSON.stringify({
    count: templates.length,
    event: "automation_suggestions_refilled",
    organizationId: input.organizationId,
  }));
}

let running = false;

// Writes suggestions for organizations that have none for today, a few at a
// time. Workers claim each organization's day, so they do not repeat work.
export async function generateDueAutomationSuggestions(
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<void> {
  if (running || now.getUTCHours() < morningHourUtc) return;
  const model = automationSuggestionModel(environment);
  if (!model) return;
  running = true;
  try {
    const day = automationSuggestionDay(now);
    const organizationIds = await listOrganizationsDueForAutomationSuggestions({
      activeSince: new Date(now.getTime() - activeWindowMs),
      day,
      limit: organizationsPerPass,
      now,
    });
    for (const organizationId of organizationIds) {
      if (!(await claimAutomationSuggestionDay({ day, now: new Date(), organizationId }))) continue;
      await generateAutomationSuggestions({ day, model, now, organizationId });
    }
    await deleteOldAutomationSuggestions(now);
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : "Suggestion pass failed",
      event: "automation_suggestions_pass_failed",
    }));
  } finally {
    running = false;
  }
}
