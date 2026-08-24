import { PostHog } from "posthog-node";
import { getOrganizationName } from "./db/organizations.js";

type AnalyticsProperty = boolean | number | string | null | undefined;

const ANALYTICS_PROJECT = "responder";

export interface AnalyticsEvent {
  distinctId: string;
  event:
    | "agent created"
    | "integration connected"
    | "investigation created"
    | "investigation rerun"
    | "organization created"
    | "pr merged"
    | "pr opened"
    | "prompt copied"
    | "user signed up";
  organizationId?: string;
  properties?: Record<string, AnalyticsProperty>;
}

let client: PostHog | null | undefined;

function getClient(): PostHog | null {
  if (client !== undefined) return client;

  const projectToken = process.env.POSTHOG_PROJECT_TOKEN;
  if (!projectToken) {
    client = null;
    return client;
  }

  client = new PostHog(projectToken, {
    host: process.env.POSTHOG_HOST ?? "https://eu.i.posthog.com",
    requestTimeout: 3_000,
  });
  return client;
}

/**
 * Resolves the organization display name for an event. Callers that already
 * pass an organization_name property win; otherwise the name is looked up from
 * the database. A failed lookup returns null so it never drops the event.
 */
async function resolveOrganizationName(
  input: AnalyticsEvent,
): Promise<AnalyticsProperty> {
  if (!input.organizationId) return null;
  const provided = input.properties?.organization_name;
  if (provided !== undefined) return provided;

  try {
    return await getOrganizationName(input.organizationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Unable to resolve organization name: ${message}`);
    return null;
  }
}

/**
 * Captures a product event without allowing analytics delivery errors to fail
 * the product action. captureImmediate is intentional: both deployed
 * applications run in serverless environments where a queued event may outlive
 * the request.
 */
export async function captureAnalyticsEvent(
  input: AnalyticsEvent,
): Promise<void> {
  const posthog = getClient();
  if (!posthog) return;

  try {
    const organizationName = await resolveOrganizationName(input);
    await posthog.captureImmediate({
      distinctId: input.distinctId,
      event: input.event,
      groups: input.organizationId
        ? { organization: input.organizationId }
        : undefined,
      properties: {
        ...input.properties,
        ...(input.organizationId
          ? {
              organization_id: input.organizationId,
              ...(organizationName === null
                ? {}
                : { organization_name: organizationName }),
            }
          : {}),
        project: ANALYTICS_PROJECT,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Unable to capture ${input.event} analytics event: ${message}`);
  }
}
