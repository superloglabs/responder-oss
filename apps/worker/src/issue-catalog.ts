import { issueCatalogTriggerKinds } from "@responder/core/automations/issue-catalog";
import { issueSeveritySchema } from "@responder/core/investigations/report";
import {
  appendAutomationIssueRecords,
  attachAutomationIssue,
  AutomationIssueRunLinkedError,
  fileAutomationIssue,
  listAutomationIssueCandidates,
  listRecentAutomationRuns,
  searchAutomationIssuesByText,
  type AutomationIssue,
} from "@responder/core/db/automation-issues";
import type {
  AutomationIssueLink,
  AutomationIssueSlackMessage,
} from "@responder/core/db/schema";
import { z } from "zod";
import type { AutomationActionResult } from "./automation-actions.js";
import { automationToolServerName, skipNotificationToolName } from "./automation-harness.js";
import { cosineSimilarity, embedText } from "./issue-embeddings.js";
import { workspaceTool as tool } from "./workspace-tools.js";

export const findIssuesToolName = "find_issues";
export const fileIssueToolName = "file_issue";
export const attachIssueToolName = "attach_issue";
export const listRunsToolName = "list_runs";

// list_runs shows runs that finished this recently, beside those still going.
const recentRunWindowMs = 30 * 60 * 1_000;
const maxListedRuns = 100;
const maxFoundIssues = 10;
const maxTextOnlyIssues = 5;

// Only a run's first turn reports, so only it decides whether to file.
export function usesIssueCatalog(input: {
  firstTurn: boolean;
  notificationChannels: number;
  triggerInput: Record<string, unknown>;
}): boolean {
  return input.firstTurn &&
    input.notificationChannels > 0 &&
    typeof input.triggerInput.provider === "string" &&
    issueCatalogTriggerKinds.has(input.triggerInput.provider);
}

export function issueCatalogInstructions(): string {
  return [
    `This automation keeps a catalog of the issues it has reported, shared by all its runs, so people are told about each problem once. Use the ${findIssuesToolName}, ${listRunsToolName}, ${attachIssueToolName}, and ${fileIssueToolName} tools from the ${automationToolServerName} tool server, in this order, before you investigate in depth:`,
    `1. Call ${findIssuesToolName} with a short description of this alert. If one of the issues is the same problem, call ${attachIssueToolName} with its id, then call ${skipNotificationToolName} and finish. Do not post, open a ticket, or open a pull request for it.`,
    `2. Call ${listRunsToolName}. When it reports runs it did not list, call it again with titleContains set to a phrase from this alert's title. If runs that started before this one are handling the same problem, this run is part of a stream of repeats: call ${skipNotificationToolName} naming the earliest of those runs, and finish without filing, posting, or opening a ticket. The earliest run reports for all of them. Defer only to runs that are pending or running, or that filed an issue: when the earlier runs for the problem failed or were cancelled without filing, handle it yourself.`,
    `3. Otherwise investigate. If the result is worth reporting under the automation's instructions, call ${listRunsToolName} again, with titleContains when the alerts share a phrase, and collect the ids of the runs that started after this one for the same problem. Then call ${fileIssueToolName} with those ids as laterRunIds, link any ticket you open, and report as the automation's instructions say. When later runs repeated the alert, say how many times it fired in the post.`,
    "You decide what counts as the same problem: the same failure with the same cause, even when ids, numbers, or wording in the alert differ.",
  ].join("\n");
}

const findIssuesSchema = z.object({
  query: z.string().trim().min(1).max(2_000).describe("A short description of the problem this alert shows."),
});

const linkSchema = z.object({
  label: z.string().trim().min(1).max(200).nullable().optional(),
  // Links are shown as anchors, so only web pages are kept.
  url: z.url({ protocol: /^https?$/u }).max(2_000),
});

const fileIssueSchema = z.object({
  laterRunIds: z.array(z.uuid()).max(500).default([])
    .describe("Ids of the runs that started after this one for the same problem, from list_runs. Each counts as an occurrence."),
  links: z.array(linkSchema).max(10).default([])
    .describe("Tickets or other pages about this issue."),
  severity: issueSeveritySchema
    .describe("The severity you gave this problem, shown with the issue. SEV-1: a broad outage, data loss, or a security breach. SEV-2: a feature broken or badly degraded for many users. SEV-3: a limited or minor problem. Use the automation's own severity levels when its instructions define them."),
  summary: z.string().trim().min(1).max(4_000)
    .describe("What fails, why, and what it affects, in a few sentences."),
  title: z.string().trim().min(1).max(240),
});

const attachIssueSchema = z.object({
  issueId: z.uuid(),
});

export interface IssueCatalogDependencies {
  append: typeof appendAutomationIssueRecords;
  attach: typeof attachAutomationIssue;
  embed: (text: string) => ReturnType<typeof embedText>;
  file: typeof fileAutomationIssue;
  listCandidates: typeof listAutomationIssueCandidates;
  listRuns: typeof listRecentAutomationRuns;
  now: () => Date;
  searchText: typeof searchAutomationIssuesByText;
}

const defaultDependencies: IssueCatalogDependencies = {
  append: appendAutomationIssueRecords,
  attach: attachAutomationIssue,
  embed: (text) => embedText(text),
  file: fileAutomationIssue,
  listCandidates: listAutomationIssueCandidates,
  listRuns: listRecentAutomationRuns,
  now: () => new Date(),
  searchText: searchAutomationIssuesByText,
};

function serializeIssue(issue: AutomationIssue, similarity?: number) {
  return {
    firstSeenAt: issue.firstSeenAt.toISOString(),
    id: issue.id,
    lastSeenAt: issue.lastSeenAt.toISOString(),
    links: issue.links,
    occurrences: issue.occurrences,
    severity: issue.severity,
    slackMessages: issue.slackMessages,
    summary: issue.summary,
    title: issue.title,
    ...(similarity === undefined ? {} : { similarity: Math.round(similarity * 1_000) / 1_000 }),
  };
}

// The catalog tools for one run. Slack posts and pull requests the run makes
// are recorded on the issue it files or attaches to.
export function createIssueCatalog(
  input: { automationId: string; organizationId: string; runId: string },
  dependencies: IssueCatalogDependencies = defaultDependencies,
) {
  const catalog = { automationId: input.automationId, organizationId: input.organizationId };
  const scope = { ...catalog, runId: input.runId };
  let issueId: string | null = null;
  let pending: { links: AutomationIssueLink[]; slackMessages: AutomationIssueSlackMessage[] } = {
    links: [],
    slackMessages: [],
  };

  // Links already on the issue, so a pull request the agent also linked is
  // kept once.
  const knownLinks = new Set<string>();

  // A failed write loses the record, not the run.
  async function flush() {
    if (!issueId) return;
    const links = pending.links.filter((link) => !knownLinks.has(link.url));
    const records = { links, slackMessages: pending.slackMessages };
    pending = { links: [], slackMessages: [] };
    for (const link of links) knownLinks.add(link.url);
    if (records.links.length === 0 && records.slackMessages.length === 0) return;
    try {
      await dependencies.append({ issueId, ...records });
    } catch (error) {
      console.error(JSON.stringify({
        errorCode: error instanceof Error ? error.name : typeof error,
        event: "automation_issue_record_failed",
        runId: input.runId,
      }));
    }
  }

  async function linked(issue: AutomationIssue) {
    issueId = issue.id;
    for (const link of issue.links) knownLinks.add(link.url);
    await flush();
  }

  const findIssues = tool({
    description: "Search the issues this automation has already reported, most similar first. Each has its title, summary, how many times it occurred, when it was first and last seen, and its links and Slack posts.",
    async execute({ query }) {
      const [embedding, candidates, textMatches] = await Promise.all([
        dependencies.embed(query),
        dependencies.listCandidates(catalog),
        dependencies.searchText({ ...catalog, limit: maxFoundIssues, query }),
      ]);
      const semantic = embedding
        ? candidates
            .filter((candidate) =>
              candidate.embeddingModel === embedding.model &&
              candidate.embedding?.length === embedding.vector.length)
            .map((candidate) => ({
              issue: candidate,
              similarity: cosineSimilarity(embedding.vector, candidate.embedding!),
            }))
            .filter((match) => Number.isFinite(match.similarity))
            .sort((left, right) => right.similarity - left.similarity)
            .slice(0, maxFoundIssues)
        : [];
      // Text matches not among the most similar keep their place, so an
      // issue without an embedding can still be found.
      const similarIds = new Set(semantic.map((match) => match.issue.id));
      const textOnly = textMatches
        .filter((issue) => !similarIds.has(issue.id))
        .slice(0, maxTextOnlyIssues);
      return {
        issues: [
          ...semantic.slice(0, maxFoundIssues - textOnly.length).map((match) => serializeIssue(match.issue, match.similarity)),
          ...textOnly.map((issue) => serializeIssue(issue)),
        ],
      };
    },
    name: findIssuesToolName,
    parameters: findIssuesSchema,
    readOnly: true,
  });

  const listRuns = tool({
    description: `List this automation's runs that are in progress or finished in the last 30 minutes, oldest first. Each has its trigger title, status, start time, and the issue it filed or attached to. This run is always included. At most ${maxListedRuns} are listed; total counts all that match, so pass titleContains to narrow a storm of alerts to the ones like this.`,
    async execute({ titleContains }) {
      const { current, runs, total } = await dependencies.listRuns({
        ...catalog,
        currentRunId: input.runId,
        finishedSince: new Date(dependencies.now().getTime() - recentRunWindowMs),
        limit: maxListedRuns,
        titleContains: titleContains ?? null,
      });
      const listed = current && !runs.some((run) => run.id === current.id) ? [...runs, current] : runs;
      const shown = runs.length;
      return {
        currentRunId: input.runId,
        runs: listed.map((run) => ({
          createdAt: run.createdAt.toISOString(),
          ...(run.id === input.runId ? { current: true } : {}),
          id: run.id,
          ...(run.issueId ? { issueId: run.issueId, relationship: run.relationship } : {}),
          ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
          ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
          status: run.status,
          title: run.title?.slice(0, 300) ?? null,
        })),
        ...(total > shown ? { notListed: total - shown } : {}),
        total,
      };
    },
    name: listRunsToolName,
    parameters: z.object({
      titleContains: z.string().trim().min(1).max(200).nullable().optional()
        .describe("Only runs whose trigger title contains this text, ignoring case."),
    }),
    readOnly: true,
  });

  const fileIssue = tool({
    description: `File a new issue in this automation's catalog after investigating an alert worth reporting, before you post. Later runs find it and attach to it instead of reporting again. A run files one issue: calling again returns the issue it filed.`,
    async execute(args) {
      const embedding = await dependencies.embed(`${args.title}\n\n${args.summary}`);
      const { issue, status } = await dependencies.file({
        ...scope,
        embedding,
        links: args.links.map((link) => ({ ...(link.label ? { label: link.label } : {}), url: link.url })),
        laterRunIds: args.laterRunIds,
        severity: args.severity,
        summary: args.summary,
        title: args.title,
      });
      await linked(issue);
      if (status === "attached_by_earlier_run") {
        return {
          alreadyReported: true,
          issue: serializeIssue(issue),
          note: `An earlier run already filed and reported this problem, and counted this run as a repeat. Do not post or open a ticket: call ${skipNotificationToolName} and finish.`,
        };
      }
      return { ...(status === "filed" ? { filed: true } : { alreadyFiled: true }), issue: serializeIssue(issue) };
    },
    name: fileIssueToolName,
    parameters: fileIssueSchema,
    readOnly: false,
  });

  const attachIssue = tool({
    description: `Count this alert as another occurrence of an issue already in the catalog. Then call ${skipNotificationToolName}: the issue was already reported.`,
    async execute({ issueId: target }) {
      let result: Awaited<ReturnType<typeof dependencies.attach>>;
      try {
        result = await dependencies.attach({ ...scope, issueId: target });
      } catch (error) {
        if (error instanceof AutomationIssueRunLinkedError) {
          throw new Error(`This run is already linked to issue ${error.issueId}.`);
        }
        throw error;
      }
      if (!result) throw new Error("No issue with that id is in this automation's catalog.");
      await linked(result.issue);
      return { ...(result.attached ? { attached: true } : { alreadyAttached: true }), issue: serializeIssue(result.issue) };
    },
    name: attachIssueToolName,
    parameters: attachIssueSchema,
    readOnly: false,
  });

  return {
    async recordAction(action: AutomationActionResult): Promise<void> {
      if (action.kind === "send_slack_message" && action.externalReference) {
        const separator = action.externalReference.indexOf(":");
        const timestamp = action.externalReference.slice(separator + 1);
        if (separator <= 0 || timestamp === "sent") return;
        pending.slackMessages.push({ channelId: action.externalReference.slice(0, separator), timestamp });
      } else if (action.kind === "open_github_pull_request" && action.externalReference) {
        pending.links.push({ label: action.title ?? "Pull request", url: action.externalReference });
      } else {
        return;
      }
      await flush();
    },
    tools: [findIssues, listRuns, fileIssue, attachIssue],
  };
}
