import { triggerAccountIds, type AutomationConfiguration, type AutomationOptions, type AutomationTrigger, type ConnectedAutomationTrigger } from "../automations-api";
import { browserTimeZone } from "../automation-configuration";
import type { AutomationConnectorProvider } from "../components/automation-connectors";

export type AutomationTemplateCategory = "support" | "bug_triage" | "scans";

export const automationTemplateCategoryLabels: Record<AutomationTemplateCategory, string> = {
  bug_triage: "Bug triage",
  scans: "Scans",
  support: "Support",
};

// A starting point for a new automation, built in or shared by another
// workspace. Triggers have no connection or channels; the create page fills
// in the connections and the user picks the channels, projects, and
// repositories.
export interface AutomationTemplateContent {
  // Connectors besides the triggers' own connections.
  connectors: string[];
  description: string;
  name: string;
  prompt: string;
  triggers: AutomationTrigger[];
}

export interface AutomationTemplate extends AutomationTemplateContent {
  category: AutomationTemplateCategory;
  connectors: AutomationConnectorProvider[];
  id: string;
}

// Scheduled templates use the member's time zone when applied.
const weeklyAtNine = { frequency: "weekly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 } as const;

export const automationTemplates: AutomationTemplate[] = [
  {
    category: "support",
    connectors: ["github"],
    description: "When someone asks a question in your support channel, read the code and docs, then reply in the thread with an answer and links.",
    id: "answer-support-questions",
    name: "Answer support questions",
    prompt: [
      "A question was posted in the support channel.",
      "Find the answer in the selected repositories, including their docs, configuration, and code.",
      "Reply in the thread with a short, direct answer and link to the files or docs that support it.",
      "If the question describes a bug rather than a usage question, say so and summarize what you found.",
      "If you cannot find a confident answer, say what you checked and do not guess.",
    ].join("\n"),
    triggers: [{ channelIds: [], eventMode: "every_message", integrationAccountId: "", kind: "slack" }],
  },
  {
    category: "support",
    connectors: ["github"],
    description: "When someone runs /automate in your community channel, look up the answer in your code and docs and reply with it.",
    id: "answer-community-questions",
    name: "Answer community questions",
    prompt: [
      "A community member asked a question with the /automate command in Discord.",
      "Find the answer in the selected repositories, including their docs, examples, and code.",
      "Reply with a short, friendly answer that a user outside the team can follow, with links to public docs where they exist.",
      "Do not share internal details such as private file paths, credentials, or unreleased plans.",
      "If you cannot find a confident answer, say so and suggest where the person can get help.",
    ].join("\n"),
    triggers: [{ channelIds: [], integrationAccountId: "", kind: "discord" }],
  },
  {
    category: "support",
    connectors: ["sentry", "github"],
    description: "When support mentions the app on a customer report, find the matching Sentry issue and reply with its status and a workaround.",
    id: "match-reports-to-errors",
    name: "Match reports to known errors",
    prompt: [
      "A support teammate mentioned you on a customer report.",
      "Search Sentry for issues that match the report by error message, affected page or endpoint, and time.",
      "Reply in the thread with the matching issue, how many users it affects, and whether it is resolved, ignored, or still open.",
      "Look at the related code in the selected repositories and suggest a workaround the customer can use now.",
      "If nothing matches, say so and list the details that would help engineering reproduce it.",
    ].join("\n"),
    triggers: [{ channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" }],
  },
  {
    category: "bug_triage",
    connectors: ["github", "slack"],
    description: "Rate severity, trace the root cause in your repositories, and post a summary with the suspected commit and owner to Slack.",
    id: "triage-sentry-issues",
    name: "Triage new Sentry issues",
    prompt: [
      "A new Sentry issue was created.",
      "Rate its severity from the error rate, the number of affected users, and the code path involved.",
      "Trace the stack trace to the code in the selected repositories and find the change that most likely introduced it.",
      "Post a summary to the engineering Slack channel with the severity, root cause, suspected commit, and likely owner.",
      "If the fix is small and clear, open a pull request with the fix and a regression test.",
    ].join("\n"),
    triggers: [{ eventTypes: ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: [] }],
  },
  {
    category: "bug_triage",
    connectors: ["github"],
    description: "When a bug is posted in your bugs channel, reproduce it, open a pull request with a regression test, and reply with the link.",
    id: "fix-slack-bug-reports",
    name: "Fix bugs reported in Slack",
    prompt: [
      "A bug was reported in the bugs channel.",
      "Reproduce it in the selected repositories with a failing test.",
      "Fix the cause, run the focused tests, and open a pull request that explains the bug and the fix.",
      "Reply in the thread with the pull request link and a one-line summary.",
      "If you cannot reproduce the bug, reply with what you tried and the details you need.",
    ].join("\n"),
    triggers: [{ channelIds: [], eventMode: "every_message", integrationAccountId: "", kind: "slack" }],
  },
  {
    category: "bug_triage",
    connectors: ["github", "datadog"],
    description: "When a resolved Sentry issue comes back, compare it with the earlier fix, check Datadog logs, and open a pull request.",
    id: "fix-sentry-regressions",
    name: "Fix regressions",
    prompt: [
      "A Sentry issue that was resolved has happened again.",
      "Find the change that resolved it before and check whether a later change undid or bypassed that fix.",
      "Use Datadog logs around the new events to confirm which requests and releases are affected.",
      "Open a pull request that restores the fix and adds a regression test so it cannot come back unnoticed.",
    ].join("\n"),
    triggers: [{ eventTypes: ["regression"], integrationAccountId: "", kind: "sentry", projectIds: [] }],
  },
  {
    category: "scans",
    connectors: ["github", "sentry", "datadog", "slack"],
    description: "Every hour, compare Sentry error rates and Datadog latency, errors, and saturation with their usual range, and alert Slack when one is out of range.",
    id: "reliability-check",
    name: "Reliability check",
    prompt: [
      "This is an hourly reliability check.",
      "In Sentry, compare the error count and affected users for the past hour with the same hour on each of the past seven days, and look for new or spiking issues.",
      "In Datadog, compare request latency, error rate, throughput, and resource saturation for the past hour with the same hour on each of the past seven days, and check for monitors in alert or warning.",
      "Treat a value as out of range when it is well outside what the past week shows for that hour, not when it moves slightly.",
      "For each value out of range, find the likely cause, such as a recent deploy, a dependency, or a traffic change, using the selected repositories and recent commits.",
      "Post one message to the #engineering Slack channel that lists each value out of range, its usual range, the likely cause, and links to the Sentry issue or Datadog dashboard.",
      "If every value is in range, do not post anything.",
    ].join("\n"),
    triggers: [{ ...weeklyAtNine, frequency: "hourly" }],
  },
  {
    category: "scans",
    connectors: ["github", "sentry", "datadog"],
    description: "Every week, find code paths behind recent errors that are hard to debug, and open a pull request that adds the missing logs, tags, and spans.",
    id: "review-observability",
    name: "Review observability",
    prompt: [
      "This is a weekly observability review.",
      "Look at the Sentry issues from the past seven days and the matching logs and traces in Datadog.",
      "Find the code paths where an engineer could not tell what happened from the telemetry, for example a missing request or user ID, inputs, upstream responses, or timing.",
      "Open a pull request that adds structured logs, error tags, and trace spans for those gaps. Follow the logging and tracing conventions already used in the repository.",
      "Do not log secrets, tokens, or personal data.",
    ].join("\n"),
    triggers: [weeklyAtNine],
  },
  {
    category: "scans",
    connectors: ["github", "datadog", "slack"],
    description: "Every week, find the slowest endpoints and queries in Datadog, trace them in your code, and open pull requests for safe fixes.",
    id: "review-performance",
    name: "Review performance",
    prompt: [
      "This is a weekly performance review.",
      "In Datadog, find the endpoints, jobs, and database queries that spent the most time over the past seven days, and those that got slower than the week before.",
      "Trace each one in the selected repositories. Look for repeated or unindexed queries, work inside loops that could be batched, blocking calls on hot paths, missing caching or pagination, and large payloads.",
      "Open a pull request for each fix that is small and safe, with the measured cost in its description.",
      "Post a short report to the #engineering Slack channel with the findings ordered by impact and links to the pull requests.",
    ].join("\n"),
    triggers: [weeklyAtNine],
  },
  {
    category: "scans",
    connectors: ["github", "slack"],
    description: "Every week, review the changes merged in the past seven days for layering problems, wrong-way dependencies, and duplicated logic.",
    id: "review-architecture",
    name: "Review architecture",
    prompt: [
      "This is a weekly architecture review.",
      "Learn the existing structure of the selected repositories first: module boundaries, layering, shared libraries, and the conventions in their docs.",
      "Review the changes merged in the past seven days against that structure. Look for dependencies in the wrong direction, business logic in transport or storage code, duplicated logic that already exists elsewhere, and new abstractions with a single use.",
      "Post the findings that matter most to the #engineering Slack channel, each with the files involved, the commit, and a concrete alternative.",
      "Do not comment on formatting or naming unless it hides a structural problem. If nothing stands out, say so in one line.",
    ].join("\n"),
    triggers: [weeklyAtNine],
  },
  {
    category: "scans",
    connectors: ["github", "sentry"],
    description: "Every week, find recently changed code and past production errors without tests, and open a pull request that adds them.",
    id: "review-testing",
    name: "Review test coverage",
    prompt: [
      "This is a weekly test coverage review.",
      "Find the code changed in the past seven days in the selected repositories and read its tests. Run the tests to see what passes.",
      "List behavior that no test covers, especially error handling, edge cases, and branches the recent changes added.",
      "Check Sentry for errors from the past seven days in this code, and add a regression test for each one that has none.",
      "Open a pull request that adds the missing tests using the framework and style already in the repository.",
    ].join("\n"),
    triggers: [weeklyAtNine],
  },
];

// Shown first, in this order, before the member picks a category.
const suggestedTemplateIds = [
  "answer-community-questions",
  "triage-sentry-issues",
  "reliability-check",
  "review-observability",
  "answer-support-questions",
  "review-performance",
];

export const suggestedAutomationTemplates = suggestedTemplateIds.flatMap((id) => automationTemplates.find((template) => template.id === id) ?? []);

export function findAutomationTemplate(id: string | null | undefined): AutomationTemplate | undefined {
  return id ? automationTemplates.find((template) => template.id === id) : undefined;
}

// Applies a template to a new automation. Triggers and connectors use the
// first connection of each provider; missing connections are left for the
// user to connect from the page. Schedules run in `timezone`.
export function applyAutomationTemplate(configuration: AutomationConfiguration, template: AutomationTemplateContent, options: AutomationOptions, timezone = browserTimeZone()): AutomationConfiguration {
  const triggers = template.triggers.map((trigger): AutomationTrigger => trigger.kind === "schedule"
    ? { ...trigger, timezone }
    : { ...trigger, integrationAccountId: options.accounts.find((account) => account.provider === trigger.kind)?.id ?? "" });
  const triggerAccounts = triggerAccountIds(triggers);
  const contextAccountIds = template.connectors.flatMap((provider) => {
    const account = options.accounts.find((candidate) => candidate.provider === provider && !triggerAccounts.includes(candidate.id));
    return provider === "github" || !account ? [] : [account.id];
  });
  return { ...configuration, contextAccountIds, prompt: template.prompt, triggers };
}

const triggerResources: Record<ConnectedAutomationTrigger["kind"], string> = {
  discord: "a Discord channel",
  sentry: "a Sentry project",
  slack: "a Slack channel",
};

// What the user still chooses after applying a template, for the page notice.
export function automationTemplateMissingFields(template: Pick<AutomationTemplateContent, "triggers">): string {
  const resources = [...new Set(template.triggers.flatMap((trigger) => trigger.kind === "schedule" ? [] : [triggerResources[trigger.kind]]))];
  const fields = [...resources, "a repository"];
  return fields.length > 2 ? `${fields.slice(0, -1).join(", ")}, and a repository` : fields.join(" and ");
}
