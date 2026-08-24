import { z } from "zod";

const slackResponseSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    errors: z
      .array(
        z
          .object({
            code: z.string().optional(),
            message: z.string().optional(),
            pointer: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    response_metadata: z
      .object({ messages: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    ts: z.string().optional(),
  })
  .passthrough();

function slackErrorDiagnostics(
  response: z.infer<typeof slackResponseSchema>,
): string[] {
  return [
    ...(response.errors ?? []).map((error) =>
      [error.code, error.pointer, error.message].filter(Boolean).join(": "),
    ),
    ...(response.response_metadata?.messages ?? []),
  ]
    .filter((message) => message.trim().length > 0)
    .slice(0, 8)
    .map((message) => message.replaceAll(/\s+/g, " ").slice(0, 500));
}

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: string,
    public readonly diagnostics: string[] = [],
  ) {
    super(`Slack ${method} failed (${code})`);
    this.name = "SlackApiError";
  }
}

async function callSlackApi(
  accessToken: string,
  method: string,
  body: Record<string, unknown>,
) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const parsed = slackResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!response.ok || !parsed.success || !parsed.data.ok) {
    const code = parsed.success
      ? parsed.data.error ?? `http_${response.status}`
      : `http_${response.status}`;
    throw new SlackApiError(
      method,
      code,
      parsed.success ? slackErrorDiagnostics(parsed.data) : [],
    );
  }
  return parsed.data;
}

export async function addSlackReaction(input: {
  accessToken: string;
  channelId: string;
  name: string;
  timestamp: string;
}): Promise<void> {
  try {
    await callSlackApi(input.accessToken, "reactions.add", {
      channel: input.channelId,
      name: input.name,
      timestamp: input.timestamp,
    });
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "already_reacted") {
      return;
    }
    throw error;
  }
}

export async function removeSlackReaction(input: {
  accessToken: string;
  channelId: string;
  name: string;
  timestamp: string;
}): Promise<void> {
  try {
    await callSlackApi(input.accessToken, "reactions.remove", {
      channel: input.channelId,
      name: input.name,
      timestamp: input.timestamp,
    });
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "no_reaction") {
      return;
    }
    throw error;
  }
}

export async function postSlackMessage(input: {
  accessToken: string;
  blocks?: unknown[];
  channelId: string;
  text: string;
  threadTimestamp?: string;
}): Promise<string | null> {
  const response = await callSlackApi(input.accessToken, "chat.postMessage", {
    channel: input.channelId,
    text: input.text,
    ...(input.blocks ? { blocks: input.blocks } : {}),
    ...(input.threadTimestamp ? { thread_ts: input.threadTimestamp } : {}),
  });
  return response.ts ?? null;
}

export async function updateSlackMessage(input: {
  accessToken: string;
  blocks: unknown[];
  channelId: string;
  text: string;
  timestamp: string;
}): Promise<void> {
  await callSlackApi(input.accessToken, "chat.update", {
    blocks: input.blocks,
    channel: input.channelId,
    text: input.text,
    ts: input.timestamp,
  });
}

export async function setSlackThreadStatus(input: {
  accessToken: string;
  channelId: string;
  loadingMessages?: string[];
  status: string;
  threadTimestamp: string;
}): Promise<void> {
  await callSlackApi(input.accessToken, "assistant.threads.setStatus", {
    channel_id: input.channelId,
    status: input.status,
    thread_ts: input.threadTimestamp,
    ...(input.loadingMessages
      ? { loading_messages: input.loadingMessages }
      : {}),
  });
}

export async function postSlackEphemeralMessage(input: {
  accessToken: string;
  blocks: unknown[];
  channelId: string;
  text: string;
  threadTimestamp?: string;
  userId: string;
}): Promise<string | null> {
  const response = await callSlackApi(input.accessToken, "chat.postEphemeral", {
    blocks: input.blocks,
    channel: input.channelId,
    text: input.text,
    ...(input.threadTimestamp ? { thread_ts: input.threadTimestamp } : {}),
    user: input.userId,
  });
  return response.ts ?? null;
}
