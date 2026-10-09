import { createChatConnectionTicket, chatConnectionHandoffUrl } from "../integrations/chat-connection.js";
import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { integrationCatalog, integrationIsConfigured, productIntegrationIds } from "../integrations/catalog.js";
import { startIntegrationConnection } from "../integrations/routes.js";
import { controlPlaneBaseUrl } from "../integrations/urls.js";
import { defineOperation, ManagementError } from "./operation.js";

const consentProviders = new Set([
  "slack", "github", "sentry", "discord", "vercel", "linear", "gcp", "axiom", "posthog",
]);
const provider = z.enum(productIntegrationIds);
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
      const automations = await organizationHasCapability(context.organizationId, "automations");
      return { integrations: integrationCatalog
        .filter((item) => item.implemented && (item.id !== "discord" || automations))
        .map((item) => ({
          provider: item.id, name: item.name, description: item.description,
          available: integrationIsConfigured(item),
          connectionType: consentProviders.has(item.id) ? "oauth" as const : "secure_setup" as const,
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
      if (!definition.implemented || (input.provider === "discord" &&
          !await organizationHasCapability(context.organizationId, "automations"))) {
        throw new ManagementError(404, "Integration is not available.", "integration_unavailable");
      }
      if (!integrationIsConfigured(definition)) {
        throw new ManagementError(503, "This integration is not configured on this Superlog server.", "integration_not_configured");
      }
      if (!consentProviders.has(input.provider)) {
        return {
          provider: input.provider, connectionType: "secure_setup" as const,
          status: "setup_required" as const, url: new URL("/settings", controlPlaneBaseUrl()).href,
          expiresAt: null,
          instructions: `Open integrations and choose Add for ${definition.name} to complete secure setup. Do not enter credentials in chat. Return here afterward to verify the connection.`,
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
