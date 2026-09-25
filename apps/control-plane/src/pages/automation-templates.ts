import type { AutomationConfiguration, AutomationOptions, AutomationTrigger } from "../automations-api";
import type { AutomationConnectorProvider } from "../components/automation-connectors";

export type AutomationTemplateCategory = "support" | "bug_triage" | "code_review";

export const automationTemplateCategoryLabels: Record<AutomationTemplateCategory, string> = {
  bug_triage: "Bug triage",
  code_review: "Code review",
  support: "Support",
};

// A starting point for a new automation. The trigger has no connection or
// channels; the create page fills in the connection and the user picks the
// channels, projects, and repositories.
export interface AutomationTemplate {
  category: AutomationTemplateCategory;
  // Connectors besides the trigger's own connection.
  connectors: AutomationConnectorProvider[];
  description: string;
  id: string;
  name: string;
  prompt: string;
  trigger: AutomationTrigger;
}

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
    trigger: { channelIds: [], eventMode: "every_message", integrationAccountId: "", kind: "slack" },
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
    trigger: { channelIds: [], integrationAccountId: "", kind: "discord" },
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
    trigger: { channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" },
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
    trigger: { eventTypes: ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: [] },
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
    trigger: { channelIds: [], eventMode: "every_message", integrationAccountId: "", kind: "slack" },
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
    trigger: { eventTypes: ["regression"], integrationAccountId: "", kind: "sentry", projectIds: [] },
  },
  {
    category: "code_review",
    connectors: ["github", "datadog"],
    description: "When a new Sentry issue lacks the context to debug it, add the missing logs, tags, and spans to the code path in a pull request.",
    id: "review-observability",
    name: "Review observability",
    prompt: [
      "A new Sentry issue was created. Review whether the code path that raised it can be debugged from its telemetry.",
      "Check the stack trace, breadcrumbs, and tags in Sentry, and the matching logs and traces in Datadog.",
      "List what an engineer would need but cannot see, such as the request or user ID, inputs, upstream responses, or timing.",
      "Open a pull request that adds structured logs, error tags, and trace spans for those gaps. Follow the logging and tracing conventions already used in the repository.",
      "Do not log secrets, tokens, or personal data.",
    ].join("\n"),
    trigger: { eventTypes: ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: [] },
  },
  {
    category: "code_review",
    connectors: ["github", "datadog"],
    description: "Mention the app with a pull request, endpoint, or path. It looks for slow queries, extra work, and blocking calls, and replies with fixes.",
    id: "review-performance",
    name: "Review performance",
    prompt: [
      "A teammate mentioned you with a pull request, an endpoint, or a path to review for performance.",
      "Read that code in the selected repositories and trace the request path end to end.",
      "Look for repeated or unindexed database queries, work inside loops that could be batched, blocking calls on hot paths, missing caching or pagination, and large payloads.",
      "Use Datadog traces and metrics, when they exist, to confirm which issues cost the most time in production.",
      "Reply in the thread with the findings ordered by impact, each with the file, the cause, and the fix. Open a pull request for fixes that are small and safe.",
    ].join("\n"),
    trigger: { channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" },
  },
  {
    category: "code_review",
    connectors: ["github"],
    description: "Mention the app with a pull request or design. It checks module boundaries, dependencies, and duplicated logic against the codebase.",
    id: "review-architecture",
    name: "Review architecture",
    prompt: [
      "A teammate mentioned you with a pull request, a design, or a part of the codebase to review for architecture.",
      "Learn the existing structure of the selected repositories first: module boundaries, layering, shared libraries, and the conventions in their docs.",
      "Check whether the change follows that structure. Look for dependencies in the wrong direction, business logic in transport or storage code, duplicated logic that already exists elsewhere, and new abstractions with a single use.",
      "Reply in the thread with the findings that matter most, each with the files involved and a concrete alternative.",
      "Do not comment on formatting or naming unless it hides a structural problem.",
    ].join("\n"),
    trigger: { channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" },
  },
  {
    category: "code_review",
    connectors: ["github", "sentry"],
    description: "Mention the app with a pull request or path. It finds untested behavior and past production errors, then opens a pull request with tests.",
    id: "review-testing",
    name: "Review test coverage",
    prompt: [
      "A teammate mentioned you with a pull request or a path to review for test coverage.",
      "Read the code and its existing tests in the selected repositories, and run the tests to see what passes.",
      "List behavior that no test covers, especially error handling, edge cases, and branches changed by the pull request.",
      "Check Sentry for recent errors in this code and include a test for each one that has no regression test.",
      "Open a pull request that adds the missing tests using the framework and style already in the repository, and reply in the thread with what it covers.",
    ].join("\n"),
    trigger: { channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" },
  },
];

export function findAutomationTemplate(id: string | null | undefined): AutomationTemplate | undefined {
  return id ? automationTemplates.find((template) => template.id === id) : undefined;
}

// Applies a template to a new automation. The trigger and connectors use the
// first connection of each provider; missing connections are left for the
// user to connect from the page.
export function applyAutomationTemplate(configuration: AutomationConfiguration, template: AutomationTemplate, options: AutomationOptions): AutomationConfiguration {
  const triggerAccountId = options.accounts.find((account) => account.provider === template.trigger.kind)?.id ?? "";
  const contextAccountIds = template.connectors.flatMap((provider) => {
    const account = options.accounts.find((candidate) => candidate.provider === provider && candidate.id !== triggerAccountId);
    return provider === "github" || !account ? [] : [account.id];
  });
  return {
    ...configuration,
    contextAccountIds,
    prompt: template.prompt,
    trigger: { ...template.trigger, integrationAccountId: triggerAccountId },
  };
}

// What the user still chooses after applying a template, for the page notice.
export function automationTemplateMissingFields(template: AutomationTemplate): string {
  const resource = template.trigger.kind === "sentry" ? "a Sentry project" : template.trigger.kind === "discord" ? "a Discord channel" : "a Slack channel";
  return `${resource} and a repository`;
}
