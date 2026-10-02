import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { linearGraphql } from "./linear.js";

// People mention Responder or delegate an issue to it in Linear. Linear then
// opens an agent session and sends AgentSessionEvent webhooks: `created` for
// the first request and `prompted` for each follow-up in the session.

// Linear rejects deliveries signed more than a minute before they arrive.
export const linearWebhookMaxAgeMs = 60_000;

export const linearAgentSessionAttribute = "linearAgentSessionId";
export const linearIssueIdentifierAttribute = "linearIssueIdentifier";

const linearAgentIssueSchema = z
  .object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string(),
    url: z.string().optional(),
  })
  .passthrough();

export const linearAgentSessionEventSchema = z
  .object({
    type: z.literal("AgentSessionEvent"),
    action: z.string().min(1),
    organizationId: z.string().min(1),
    webhookTimestamp: z.number(),
    promptContext: z.string().nullish(),
    agentSession: z
      .object({
        id: z.string().min(1),
        issue: linearAgentIssueSchema.nullish(),
        creator: z.object({ name: z.string().nullish() }).passthrough().nullish(),
        url: z.string().nullish(),
      })
      .passthrough(),
    agentActivity: z
      .object({
        id: z.string().min(1),
        content: z
          .object({ type: z.string(), body: z.string().nullish() })
          .passthrough(),
        signal: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type LinearAgentSessionEvent = z.infer<
  typeof linearAgentSessionEventSchema
>;

// Linear signs the raw body with HMAC-SHA256 and puts the signing time in
// the signed body, so a replayed delivery fails the age check.
export function verifyLinearWebhook(input: {
  body: string;
  now?: number;
  secret: string;
  signature: string | undefined;
}): boolean {
  if (!input.signature) return false;
  const expected = Buffer.from(
    createHmac("sha256", input.secret).update(input.body).digest("hex"),
  );
  const received = Buffer.from(input.signature);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return false;
  }
  let timestamp: unknown;
  try {
    timestamp = (JSON.parse(input.body) as { webhookTimestamp?: unknown })
      .webhookTimestamp;
  } catch {
    return false;
  }
  return (
    typeof timestamp === "number" &&
    Number.isFinite(timestamp) &&
    Math.abs((input.now ?? Date.now()) - timestamp) <= linearWebhookMaxAgeMs
  );
}

// The request text the agent works on. A new session carries Linear's
// prompt context: the issue, the comment thread, and workspace guidance.
// A follow-up carries the person's new message.
export function linearAgentRequestBody(
  event: LinearAgentSessionEvent,
): string | null {
  const body =
    event.action === "created"
      ? event.promptContext
      : event.action === "prompted"
        ? event.agentActivity?.content.body
        : null;
  return body?.trim() ? body.trim().slice(0, 100_000) : null;
}

export type LinearAgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

export async function createLinearAgentActivity(input: {
  accessToken: string;
  agentSessionId: string;
  content: LinearAgentActivityContent;
  ephemeral?: boolean;
  fetchImpl?: typeof fetch;
  // A fixed ID makes a retried activity a duplicate instead of a second post.
  id?: string;
}): Promise<void> {
  const data = await linearGraphql({
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    query: `mutation ResponderAgentActivity($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) { success }
    }`,
    variables: {
      input: {
        agentSessionId: input.agentSessionId,
        content: input.content,
        ...(input.ephemeral ? { ephemeral: true } : {}),
        ...(input.id ? { id: input.id } : {}),
      },
    },
  });
  z.object({ success: z.literal(true) }).parse(data.agentActivityCreate);
}
