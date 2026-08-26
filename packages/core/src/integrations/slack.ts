import { z } from "zod";

const slackResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function slackErrorDiagnostics(
  response: z.infer<typeof slackResponseSchema>,
): string[] {
  const errors = Array.isArray(response.errors) ? response.errors : [];
  const responseMetadata = objectValue(response.response_metadata);
  const metadataMessages = Array.isArray(responseMetadata?.messages)
    ? responseMetadata.messages
    : [];
  return [
    ...errors.flatMap((value) => {
      const error = objectValue(value);
      if (!error) return [];
      const detail = [error.code, error.pointer, error.message]
        .map(stringValue)
        .filter((value): value is string => value !== null)
        .join(": ");
      return detail ? [detail] : [];
    }),
    ...metadataMessages.flatMap((value) => {
      const message = stringValue(value);
      return message ? [message] : [];
    }),
  ]
    .filter((message) => message.trim().length > 0)
    .slice(0, 8)
    .map((message) => message.replaceAll(/\s+/g, " ").slice(0, 500));
}

function slackResponseSummary(response: Response, responseText: string): string {
  const contentType =
    response.headers
      .get("content-type")
      ?.replaceAll(/\s+/g, " ")
      .slice(0, 100) ?? "unknown";
  const byteLength = new TextEncoder().encode(responseText).byteLength;
  return `status=${response.status}, content-type=${contentType}, bytes=${byteLength}`;
}

function slackResponseExcerpt(responseText: string): string {
  const excerpt = responseText.replaceAll(/\s+/g, " ").trim().slice(0, 500);
  return excerpt || "<empty>";
}

function slackResponseShapeDiagnostics(
  response: Response,
  responseText: string,
  error: z.ZodError,
): string[] {
  return [
    `Slack returned an invalid response shape (${slackResponseSummary(response, responseText)}); body=${slackResponseExcerpt(responseText)}`,
    ...error.issues.slice(0, 7).map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "response";
      return `Invalid field ${path} (${issue.code})`;
    }),
  ];
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
  const responseText = await response.text();
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    const detail = responseText.trim()
      ? "Slack returned invalid JSON"
      : "Slack returned an empty response";
    throw new SlackApiError(method, `http_${response.status}`, [
      `${detail} (${slackResponseSummary(response, responseText)}); body=${slackResponseExcerpt(responseText)}`,
    ]);
  }
  const parsed = slackResponseSchema.safeParse(responseBody);
  if (!response.ok || !parsed.success || !parsed.data.ok) {
    const code = parsed.success
      ? stringValue(parsed.data.error) ?? `http_${response.status}`
      : `http_${response.status}`;
    throw new SlackApiError(
      method,
      code,
      parsed.success
        ? slackErrorDiagnostics(parsed.data)
        : slackResponseShapeDiagnostics(response, responseText, parsed.error),
    );
  }
  return parsed.data;
}

function isRetryableSlackPostError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof SlackApiError &&
      /^http_(?:200|408|425|429|5\d\d)$/u.test(error.code))
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  clientMessageId?: string;
  text: string;
  threadTimestamp?: string;
}): Promise<string | null> {
  const body = {
    channel: input.channelId,
    ...(input.clientMessageId
      ? { client_msg_id: input.clientMessageId }
      : {}),
    text: input.text,
    ...(input.blocks ? { blocks: input.blocks } : {}),
    ...(input.threadTimestamp ? { thread_ts: input.threadTimestamp } : {}),
  };
  try {
    const response = await callSlackApi(
      input.accessToken,
      "chat.postMessage",
      body,
    );
    return stringValue(response.ts);
  } catch (error) {
    if (!input.clientMessageId || !isRetryableSlackPostError(error)) {
      throw error;
    }
    await wait(100);
    try {
      const response = await callSlackApi(
        input.accessToken,
        "chat.postMessage",
        body,
      );
      return stringValue(response.ts);
    } catch (retryError) {
      throw new AggregateError(
        [error, retryError],
        "Slack chat.postMessage retry failed",
      );
    }
  }
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
  return stringValue(response.ts);
}
