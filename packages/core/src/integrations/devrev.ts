import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const DEVREV_API_URL = "https://api.devrev.ai";

const devrevCredentialsSchema = z.object({
  authType: z.literal("personal_access_token"),
  token: z.string().min(1),
  // The webhook Responder registered for new tickets, once it exists.
  webhookId: z.string().min(1).optional(),
  webhookSecret: z.string().min(1).optional(),
});

export type DevRevCredentials = z.infer<typeof devrevCredentialsSchema>;

export function parseDevRevCredentials(input: unknown): DevRevCredentials {
  return devrevCredentialsSchema.parse(input);
}

export class DevRevApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`DevRev ${operation} failed (${status})`);
    this.name = "DevRevApiError";
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

type DevRevFetch = (input: string, init: RequestInit) => Promise<Response>;

async function callDevRev(input: {
  body?: Record<string, unknown>;
  fetch?: DevRevFetch;
  operation: string;
  token: string;
}): Promise<unknown> {
  const response = await (input.fetch ?? fetch)(`${DEVREV_API_URL}/${input.operation}`, {
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.token}`,
      ...(input.body ? { "content-type": "application/json" } : {}),
    },
    method: input.body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new DevRevApiError(input.operation, response.status);
  return response.json() as Promise<unknown>;
}

const devOrgResponseSchema = z.object({
  dev_org: z.object({
    dev_slug: z.string().min(1).optional(),
    display_name: z.string().optional(),
    id: z.string().min(1),
  }),
});

// The DevRev organization a token belongs to.
export async function getDevRevOrganization(
  token: string,
  fetchImpl?: DevRevFetch,
): Promise<{ displayName: string; id: string; slug: string | null }> {
  const { dev_org: organization } = devOrgResponseSchema.parse(
    await callDevRev({ fetch: fetchImpl, operation: "dev-orgs.get", token }),
  );
  return {
    displayName: organization.display_name?.trim() || organization.dev_slug || "DevRev",
    id: organization.id,
    slug: organization.dev_slug ?? null,
  };
}

const webhookResponseSchema = z.object({
  webhook: z.object({
    id: z.string().min(1),
    secret: z.string().min(1),
  }),
});

// Registers a webhook for new work items. DevRev then sends a verify request
// that the endpoint answers before the webhook becomes active.
export async function createDevRevTicketWebhook(
  input: { token: string; url: string },
  fetchImpl?: DevRevFetch,
): Promise<{ id: string; secret: string }> {
  const { webhook } = webhookResponseSchema.parse(await callDevRev({
    body: { event_types: ["work_created"], url: input.url },
    fetch: fetchImpl,
    operation: "webhooks.create",
    token: input.token,
  }));
  return { id: webhook.id, secret: webhook.secret };
}

export async function deleteDevRevWebhook(
  input: { id: string; token: string },
  fetchImpl?: DevRevFetch,
): Promise<void> {
  await callDevRev({
    body: { id: input.id },
    fetch: fetchImpl,
    operation: "webhooks.delete",
    token: input.token,
  });
}

// Comments are internal, so the customer who opened the ticket does not see
// them.
export async function createDevRevTicketComment(
  input: { body: string; ticketId: string; token: string },
  fetchImpl?: DevRevFetch,
): Promise<void> {
  await callDevRev({
    body: {
      body: input.body,
      body_type: "text",
      object: input.ticketId,
      type: "timeline_comment",
      visibility: "internal",
    },
    fetch: fetchImpl,
    operation: "timeline-entries.create",
    token: input.token,
  });
}

// DevRev signs the raw body with HMAC-SHA256 under the webhook's secret and
// sends the hex digest.
export function verifyDevRevSignature(input: {
  body: string;
  secret: string;
  signature: string | undefined;
}): boolean {
  if (!input.signature) return false;
  const expected = Buffer.from(
    createHmac("sha256", input.secret).update(input.body).digest("hex"),
  );
  const received = Buffer.from(input.signature.trim().toLowerCase());
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function devrevTicketUrl(slug: string | null, displayId: string): string | undefined {
  return slug
    ? `https://app.devrev.ai/${encodeURIComponent(slug)}/works/${encodeURIComponent(displayId)}`
    : undefined;
}
