import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { automationButtonsInputSchema } from "@responder/core/automations/slack-buttons";
import { z } from "zod";
import {
  automationToolServerName,
  automationWorkspaceRoot,
  postNotificationToolName,
  skipNotificationToolName,
  type AutomationToolServer,
} from "./automation-harness.js";
import { watchHarnessEvents } from "./automation-live-transcript.js";
import { githubReadToolDefinitions } from "./github-read-tools.js";

// Tools that need Responder's credentials, such as opening a pull request,
// run in the worker. A small MCP server in the sandbox forwards each call: it
// appends the request to a file and waits for the worker to write the result.
// The worker polls the requests file like the harness events file.

const toolsRoot = `${automationWorkspaceRoot}/.responder/tools`;
const serverPath = `${toolsRoot}/server.mjs`;
const requestsPath = `${toolsRoot}/requests.jsonl`;
const responsesDirectory = `${toolsRoot}/responses`;

// The sandbox server gives up before a harness's own tool timeout, and asks
// the agent to call again; a repeated call returns the earlier result.
export const automationToolServerWaitMs = 100_000;
const requestsMaxBytes = 1_000_000;

export const automationToolServer: AutomationToolServer = {
  args: [serverPath],
  command: "node",
  name: automationToolServerName,
};

export interface AutomationToolResult {
  content: Array<{ text: string; type: "text" }>;
  isError?: true;
}

export const openPullRequestToolName = "open_pull_request";
export const checkoutPullRequestToolName = "checkout_pull_request";
export const updatePullRequestToolName = "update_pull_request";
export const replyToPullRequestCommentToolName = "reply_to_pull_request_comment";

const pullRequestProperties = {
  pullRequestNumber: { minimum: 1, type: "integer" },
  repository: {
    description: "The repository, as owner/name.",
    maxLength: 255,
    minLength: 1,
    type: "string",
  },
};

const repositoryToolDefinitions = [
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Open a GitHub pull request with the current changes in a checked-out repository's working tree, against the branch it was checked out from. Make and test the changes first. Returns the pull request URL so it can be linked in messages. Calling again with the same repository and title returns the same pull request.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        body: { maxLength: 12_000, minLength: 1, type: "string" },
        repository: {
          description: "The checked-out repository, as owner/name.",
          maxLength: 255,
          minLength: 1,
          type: "string",
        },
        title: { maxLength: 240, minLength: 1, type: "string" },
      },
      required: ["repository", "title", "body"],
      type: "object",
    },
    name: openPullRequestToolName,
  },
  {
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Replace a repository's checkout with the latest commit of a pull request this run opened, so you can change it. The old checkout's changes are saved as a patch file whose path is returned as savedChanges; they may include changes already in a pull request. Does nothing when the checkout is already at that commit.",
    inputSchema: {
      additionalProperties: false,
      properties: pullRequestProperties,
      required: ["repository", "pullRequestNumber"],
      type: "object",
    },
    name: checkoutPullRequestToolName,
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      `Push the checkout's changes as one commit to a pull request this run opened. The checkout must be at the pull request's latest commit: call ${checkoutPullRequestToolName} before making the changes. Make and test the changes first.`,
    inputSchema: {
      additionalProperties: false,
      properties: {
        ...pullRequestProperties,
        commitMessage: { maxLength: 240, minLength: 1, type: "string" },
      },
      required: ["repository", "pullRequestNumber", "commitMessage"],
      type: "object",
    },
    name: updatePullRequestToolName,
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Reply to a review comment on a pull request this run opened, in the comment's thread. Set resolve when the comment is addressed or needs no change.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        ...pullRequestProperties,
        body: { maxLength: 4_000, minLength: 1, type: "string" },
        commentId: { minimum: 1, type: "integer" },
        resolve: { type: "boolean" },
      },
      required: ["repository", "pullRequestNumber", "commentId", "body", "resolve"],
      type: "object",
    },
    name: replyToPullRequestCommentToolName,
  },
  ...githubReadToolDefinitions,
];

// The Slack message limit, less room for the link to the run.
export const maxNotificationLength = 11_000;
// Thread replies that may follow one notification message.
export const maxNotificationDetails = 10;
export const maxSkipReasonLength = 500;

export type AutomationToolDefinition = (typeof repositoryToolDefinitions)[number] | {
  annotations: Record<string, boolean>;
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
};

// A run with notification channels can post to them itself, so the agent
// knows where its results go. A turn that answers a button pressed on one of
// its posts replies in that post's thread instead. Workspace tools follow
// the run's own tools.
export function automationToolDefinitions(
  notificationChannels: string[] = [],
  workspaceTools: AutomationToolDefinition[] = [],
  inThread = false,
): AutomationToolDefinition[] {
  if (notificationChannels.length === 0) return [...repositoryToolDefinitions, ...workspaceTools];
  const postNotification = {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description: inThread
      ? `Reply in the Slack thread of the message whose button was pressed (${notificationChannels.join(", ")}). Post the complete result, not a pointer to it. Put the short result in text and longer findings in details: each details entry is posted, in order, as a further reply. Uses Markdown. If you do not reply, your final reply is posted there. Posting the same text and details again does not post them twice.`
      : `Post a message to this automation's Slack notification channels (${notificationChannels.join(", ")}). People read the automation's results there, so post the complete report, not a pointer to it. Put the short result in text and longer findings in details: each details entry is posted, in order, as a reply in the new message's thread. Uses Markdown. Returns where the message was posted. Posting the same text and details again does not post them twice.`,
    inputSchema: {
      additionalProperties: false,
      properties: {
        buttons: automationButtonsInputSchema,
        details: {
          items: { maxLength: maxNotificationLength, minLength: 1, type: "string" },
          maxItems: maxNotificationDetails,
          type: "array",
        },
        text: { maxLength: maxNotificationLength, minLength: 1, type: "string" },
      },
      required: ["text"],
      type: "object",
    },
    name: postNotificationToolName,
  };
  if (inThread) return [...repositoryToolDefinitions, postNotification, ...workspaceTools];
  return [
    ...repositoryToolDefinitions,
    postNotification,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: `Post nothing to this automation's Slack notification channels (${notificationChannels.join(", ")}) for this run, because there is nothing worth reporting. Without this call, your final reply is posted. The reason is shown in the run history. A failed run is still reported.`,
      inputSchema: {
        additionalProperties: false,
        properties: {
          reason: { maxLength: maxSkipReasonLength, minLength: 1, type: "string" },
        },
        required: ["reason"],
        type: "object",
      },
      name: skipNotificationToolName,
    },
    ...workspaceTools,
  ];
}

// Runs with the sandbox's Node.js, so it uses only built-in modules.
export function automationToolServerSource(
  root = toolsRoot,
  waitMs = automationToolServerWaitMs,
  tools = automationToolDefinitions(),
): string {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const requestsPath = ${JSON.stringify(`${root}/requests.jsonl`)};
const responsesDirectory = ${JSON.stringify(`${root}/responses`)};
const waitMs = ${waitMs};
const tools = ${JSON.stringify(tools)};

mkdirSync(responsesDirectory, { recursive: true });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(name, args) {
  const id = randomUUID();
  appendFileSync(requestsPath, JSON.stringify({ arguments: args ?? {}, id, name }) + "\\n");
  const responsePath = responsesDirectory + "/" + id + ".json";
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; await sleep(500)) {
    if (!existsSync(responsePath)) continue;
    try {
      return JSON.parse(readFileSync(responsePath, "utf8"));
    } catch {
      // The worker is still writing the response.
    }
  }
  return {
    content: [{ type: "text", text: "Superlog is still working on this request. Call the tool again with the same arguments to get its result." }],
    isError: true,
  };
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) return;
  const reply = (result) => send({ id: message.id, jsonrpc: "2.0", result });
  if (message.method === "initialize") {
    reply({
      capabilities: { tools: {} },
      protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
      serverInfo: { name: "responder-github", version: "1" },
    });
  } else if (message.method === "tools/list") {
    reply({ tools });
  } else if (message.method === "tools/call") {
    reply(await call(message.params?.name, message.params?.arguments));
  } else if (message.method === "ping") {
    reply({});
  } else {
    send({ error: { code: -32601, message: "Method not found" }, id: message.id, jsonrpc: "2.0" });
  }
});
`;
}

// Writes the server and clears requests left by an earlier turn.
export async function installAutomationToolServer(
  session: Pick<DaytonaSandboxSession, "materializeEntry">,
  notificationChannels: string[] = [],
  workspaceTools: AutomationToolDefinition[] = [],
  inThread = false,
): Promise<void> {
  await session.materializeEntry({
    entry: {
      type: "file",
      content: automationToolServerSource(
        toolsRoot,
        automationToolServerWaitMs,
        automationToolDefinitions(notificationChannels, workspaceTools, inThread),
      ),
    },
    path: serverPath,
  });
  await session.materializeEntry({
    entry: { type: "file", content: "" },
    path: requestsPath,
  });
}

const requestSchema = z.object({
  arguments: z.unknown(),
  id: z.string().regex(/^[0-9a-f-]{36}$/u),
  name: z.string().max(100),
});

export type AutomationToolRequest = Omit<z.infer<typeof requestSchema>, "id">;

// Answers tool calls while the harness runs. Requests are handled one at a
// time, in order.
export function serveAutomationTools(input: {
  handle(request: AutomationToolRequest): Promise<AutomationToolResult>;
  intervalMs?: number;
  onError(error: unknown): void;
  session: Pick<DaytonaSandboxSession, "materializeEntry" | "readFile">;
}): { stop(): Promise<void> } {
  // The requests file only grows, so each read handles the lines after the
  // ones already seen.
  let handledLines = 0;
  let queue = Promise.resolve();

  const respond = async (id: string, request: AutomationToolRequest) => {
    const result = await input.handle(request).catch((error: unknown) => {
      input.onError(error);
      return {
        content: [{ text: "The tool failed unexpectedly.", type: "text" as const }],
        isError: true as const,
      };
    });
    await input.session.materializeEntry({
      entry: { type: "file", content: JSON.stringify(result) },
      path: `${responsesDirectory}/${id}.json`,
    });
  };

  const watcher = watchHarnessEvents({
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    onEvents: (requests) => {
      // The server may still be appending the last line.
      const lines = requests.split("\n").slice(0, -1);
      for (const line of lines.slice(handledLines)) {
        handledLines += 1;
        if (!line.trim()) continue;
        let parsed: z.infer<typeof requestSchema>;
        try {
          parsed = requestSchema.parse(JSON.parse(line));
        } catch (error) {
          input.onError(error);
          continue;
        }
        const { id, ...request } = parsed;
        queue = queue.then(() => respond(id, request)).catch(input.onError);
      }
    },
    read: async () => new TextDecoder().decode(
      await input.session.readFile({ maxBytes: requestsMaxBytes, path: requestsPath }),
    ),
  });

  return {
    async stop() {
      await watcher.stop();
      await queue;
    },
  };
}
