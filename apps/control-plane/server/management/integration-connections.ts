import { createChatConnectionTicket, chatConnectionHandoffUrl } from "../integrations/chat-connection.js";
import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { automationOnlyIntegrationIds, integrationCatalog, integrationIsConfigured, productIntegrationIds, signalOnlyIntegrationIds } from "../integrations/catalog.js";
import { startIntegrationConnection } from "../integrations/routes.js";
import { jiraOAuthConfigured } from "../../../../packages/core/src/integrations/jira.js";
import { controlPlaneBaseUrl } from "../integrations/urls.js";
import { defineOperation, ManagementError } from "./operation.js";

const consentProviders = new Set([
  "slack", "github", "sentry", "discord", "vercel", "linear", "gcp", "axiom", "posthog",
  "cloudflare", "railway",
]);
const provider = z.enum(productIntegrationIds);

// Jira uses Atlassian's consent screen once its OAuth app is configured, and
// an API token in Signal's setup otherwise.
function usesConsent(id: string): boolean {
  return consentProviders.has(id) || (id === "jira" && jiraOAuthConfigured());
}

// Where secure setup happens: Signal's own pages for Jira and Render, else
// integrations. Signal's setup steps work during setup and once it is
// complete.
function secureSetupPath(id: z.infer<typeof provider>) {
  if (id === "jira") return "/signal/setup/context/jira";
  return id === "render" ? "/signal/setup/telemetry/render" : "/settings";
}
const connectionType = z.enum(["oauth", "secure_setup"]);

export const integrationConnectionOperations = [
  defineOperation({
    name: "list_available_integrations",
    // Reads the fixed local catalog and configuration, without contacting providers.
    openWorld: false,
    summary: "Find integrations to connect",
    description: "Lists the integrations this server can connect and whether each one uses a provider consent link or secure setup in Superlog. It does not show which integrations are connected.",
    method: "GET",
    path: "/integrations/available",
    tag: "Integrations",
    effect: "read",
    input: z.object({}),
    output: z.object({ integrations: z.array(z.object({
      provider, name: z.string(), description: z.string(),
      available: z.boolean(), connectionType,
    })) }),
    async run(context) {
      const [automations, signal] = await Promise.all([
        organizationHasCapability(context.organizationId, "automations"),
        organizationHasCapability(context.organizationId, "signal"),
      ]);
      return { integrations: integrationCatalog
        .filter((item) => item.implemented &&
          (!automationOnlyIntegrationIds.has(item.id) || automations) &&
          (!signalOnlyIntegrationIds.has(item.id) || signal))
        .map((item) => ({
          provider: item.id, name: item.name, description: item.description,
          available: integrationIsConfigured(item),
          connectionType: usesConsent(item.id) ? "oauth" as const : "secure_setup" as const,
        })) };
    },
  }),
  defineOperation({
    name: "start_integration_connection",
    openWorld: true,
    summary: "Get an integration consent link",
    description: "Starts connecting one integration to the workspace. For OAuth providers, returns a consent link that is personal to the signed-in person and workspace and expires after ten minutes, or status `connected` when an existing connection is recovered. A new connection completes after the person approves access in a browser signed in to the same Superlog account and workspace. For integrations that need credentials or extra setup, returns a link to secure setup in Superlog.",
    method: "POST",
    path: "/integrations/connect",
    tag: "Integrations",
    effect: "write",
    input: z.object({ provider: provider.describe("Provider selected for the user's goal.") }),
    output: z.object({
      provider, connectionType,
      status: z.enum(["awaiting_consent", "setup_required", "connected"]),
      url: z.url(), handoffUrl: z.url().optional(), expiresAt: z.iso.datetime().nullable(), instructions: z.string(),
    }),
    async run(context, input) {
      const definition = integrationCatalog.find((item) => item.id === input.provider)!;
      if (!definition.implemented || (automationOnlyIntegrationIds.has(input.provider) &&
          !await organizationHasCapability(context.organizationId, "automations")) ||
          (signalOnlyIntegrationIds.has(input.provider) &&
          !await organizationHasCapability(context.organizationId, "signal"))) {
        throw new ManagementError(404, "Integration is not available.", "integration_unavailable");
      }
      if (!integrationIsConfigured(definition)) {
        throw new ManagementError(503, "This integration is not configured on this Superlog server.", "integration_not_configured");
      }
      if (!usesConsent(input.provider)) {
        return {
          provider: input.provider, connectionType: "secure_setup" as const,
          status: "setup_required" as const, url: new URL(secureSetupPath(input.provider), controlPlaneBaseUrl()).href,
          expiresAt: null,
          instructions: input.provider === "jira"
            ? "Open Signal's Jira setup to connect Jira Cloud. Do not enter credentials in chat. Return here afterward to verify the connection."
            : input.provider === "render"
              ? "Open Signal's Render setup, paste a Render API key, and choose the services whose logs Superlog reads. Do not enter credentials in chat. Return here afterward to verify the connection."
              : `Open integrations and choose Add for ${definition.name} to complete secure setup. Do not enter credentials in chat. Return here afterward to verify the connection.`,
        };
      }
      const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
      const ticket = createChatConnectionTicket({ organizationId: context.organizationId, userId: context.user.id, provider: input.provider });
      const response = await startIntegrationConnection({
        organizationId: context.organizationId, user: context.user,
        provider: input.provider, returnTo: ticket.returnTo, mode: input.provider === "github" ? "install" : undefined,
      });
      const location = response.headers.get("location");
      if (!location) {
        throw new ManagementError(502, "Unable to start this connection. Please try again.", "integration_connection_failed");
      }
      const url = new URL(location);
      const local = url.origin === new URL(controlPlaneBaseUrl()).origin;
      if (local && url.searchParams.get("status") !== "connected") {
        throw new ManagementError(502, "Unable to start this connection. Please try again.", "integration_connection_failed");
      }
      const connectionUrl = local ? url.href : chatConnectionHandoffUrl(ticket.token, url.href);
      return {
        provider: input.provider, connectionType: "oauth" as const,
        status: local ? "connected" as const : "awaiting_consent" as const,
        url: connectionUrl, handoffUrl: local ? undefined : connectionUrl, expiresAt: local ? null : expiresAt,
        instructions: local
          ? "The existing connection was recovered. Call list_integrations to verify its resources."
          : `The connection card handles ${definition.name} authorization. Do not add a second link or repeat its instructions in chat. If the host cannot display the card, use the exact returned url without modifying it. Use the same Superlog account and workspace in the browser; verify completion with list_integrations.`,
      };
    },
  }),
];
