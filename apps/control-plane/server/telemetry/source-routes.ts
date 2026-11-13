import { Hono } from "hono";
import { z } from "zod";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { getOrganizationIntegrationAccount } from "../../../../packages/core/src/db/integrations.js";
import { organizationReceivesTelemetry } from "../../../../packages/core/src/db/organization-capabilities.js";
import { createTelemetryIngestKey } from "../../../../packages/core/src/db/telemetry-ingest-keys.js";
import {
  deleteTelemetrySource,
  getTelemetrySource,
  listTelemetrySourceAccounts,
  listTelemetrySources,
  listVercelInstallationProjectIds,
  revokeTelemetrySourceIngestKey,
  saveTelemetrySource,
} from "../../../../packages/core/src/db/telemetry-sources.js";
import { railwayAccessToken } from "../../../../packages/core/src/db/railway-access.js";
import { isAwsCommercialRegion } from "../../../../packages/core/src/integrations/aws.js";
import { McpOAuthRefreshError } from "../../../../packages/core/src/integrations/custom-mcp.js";
import {
  railwayEnvironments,
  railwayWorkspacesSchema,
  type RailwayEnvironment,
} from "../../../../packages/core/src/integrations/railway.js";
import { gcpConnectionCredentialsSchema } from "../../../../packages/core/src/integrations/gcp.js";
import { vercelCredentialsSchema } from "../../../../packages/core/src/integrations/vercel.js";
import { telemetryCollectorUrl } from "../../../../packages/core/src/telemetry/client.js";
import {
  awsTelemetryCloudFormationTemplate,
  awsTelemetryDeployCommand,
  awsTelemetryQuickCreateUrl,
  awsTelemetryStackName,
  awsTelemetryStackParameters,
  createAwsTelemetryResourcePrefix,
  createAwsTelemetryTemplateUrl,
} from "../../../../packages/core/src/telemetry/sources/aws-telemetry.js";
import {
  createVercelDrains,
  deleteVercelDrain,
  VercelDrainError,
} from "../../../../packages/core/src/telemetry/sources/vercel-drains.js";
import { getIntegrationDefinition, integrationIsConfigured } from "../integrations/catalog.js";
import { cellOrigin } from "../integrations/urls.js";
import { getActiveTenant } from "../tenant.js";

// Cloud providers that send telemetry to the workspace: Vercel drains, an AWS
// stack that streams CloudWatch through Firehose, and Google Cloud projects
// and Railway environments the worker reads. Available where applications can send telemetry, to
// workspaces with telemetry or Signal: Signal finds problems in the data
// these sources send.
export type SourceRouteDependencies = {
  accounts: typeof listTelemetrySourceAccounts;
  awsTemplateUrl: () => Promise<string | null>;
  collectorUrl: () => string | null;
  createKey: typeof createTelemetryIngestKey;
  createVercelDrains: typeof createVercelDrains;
  decrypt: (encrypted: string) => Record<string, unknown>;
  deleteSource: typeof deleteTelemetrySource;
  deleteVercelDrain: typeof deleteVercelDrain;
  getAccount: typeof getOrganizationIntegrationAccount;
  getSource: typeof getTelemetrySource;
  receivesTelemetry: (organizationId: string) => Promise<boolean>;
  ingestOrigin: () => string;
  listSources: typeof listTelemetrySources;
  providerConfigured: (provider: "gcp" | "railway" | "vercel") => boolean;
  // The Railway environments a connection shares; null when the connection
  // is gone or not connected.
  railwayEnvironments: (input: { integrationAccountId: string; organizationId: string }) => Promise<RailwayEnvironment[] | null>;
  revokeKey: typeof revokeTelemetrySourceIngestKey;
  saveSource: typeof saveTelemetrySource;
  tenant: (
    headers: Headers,
  ) => Promise<
    | { ok: true; organizationId: string; role: string; user: { id: string } }
    | { error: string; ok: false; status: 401 | 403 | 409 }
  >;
  vercelProjectIds: typeof listVercelInstallationProjectIds;
};

const defaultDependencies: SourceRouteDependencies = {
  accounts: listTelemetrySourceAccounts,
  awsTemplateUrl: () => createAwsTelemetryTemplateUrl(),
  collectorUrl: telemetryCollectorUrl,
  createKey: createTelemetryIngestKey,
  createVercelDrains,
  decrypt: (encrypted) => decryptCredentials(encrypted),
  deleteSource: deleteTelemetrySource,
  deleteVercelDrain,
  getAccount: getOrganizationIntegrationAccount,
  getSource: getTelemetrySource,
  receivesTelemetry: organizationReceivesTelemetry,
  ingestOrigin: cellOrigin,
  listSources: listTelemetrySources,
  providerConfigured: (provider) => {
    const definition = getIntegrationDefinition(provider);
    return Boolean(definition && integrationIsConfigured(definition));
  },
  railwayEnvironments: async (input) => {
    const account = await getOrganizationIntegrationAccount({ ...input, provider: "railway" });
    if (!account || account.status !== "connected") return null;
    const accessToken = await railwayAccessToken(input);
    if (!accessToken) return null;
    const workspaces = railwayWorkspacesSchema.safeParse(account.metadata.workspaces);
    return railwayEnvironments({ accessToken, workspaces: workspaces.success ? workspaces.data : [] });
  },
  revokeKey: revokeTelemetrySourceIngestKey,
  saveSource: saveTelemetrySource,
  tenant: getActiveTenant,
  vercelProjectIds: listVercelInstallationProjectIds,
};

const accountSchema = z.object({ integrationAccountId: z.uuid() });
const railwaySchema = z.object({ environmentId: z.string().trim().min(1).max(100), integrationAccountId: z.uuid() });
const awsSchema = z.object({ region: z.string().refine(isAwsCommercialRegion) });
// Stale drains are earlier drains that Vercel did not delete; removing the
// source or reconnecting tries them again.
const vercelStateSchema = z.object({
  drains: z.record(z.string(), z.string()).default({}),
  staleDrains: z.array(z.string()).default([]),
});

function vercelDrainIds(state: unknown): string[] {
  const parsed = vercelStateSchema.safeParse(state ?? {});
  return parsed.success ? [...Object.values(parsed.data.drains), ...parsed.data.staleDrains] : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSourceRoutes(dependencies: SourceRouteDependencies = defaultDependencies) {
  async function access(headers: Headers): Promise<
    | { ok: true; organizationId: string; role: string; userId: string }
    | { error: string; ok: false; status: 401 | 403 | 404 | 409 }
  > {
    const tenant = await dependencies.tenant(headers);
    if (tenant.ok === false) return { error: tenant.error, ok: false, status: tenant.status };
    if (!dependencies.collectorUrl() || !(await dependencies.receivesTelemetry(tenant.organizationId))) {
      return { error: "Sending telemetry is not available", ok: false, status: 404 };
    }
    return { ok: true, organizationId: tenant.organizationId, role: tenant.role, userId: tenant.user.id };
  }

  async function sourceKey(input: { name: string; organizationId: string; userId: string }) {
    return dependencies.createKey({ createdBy: input.userId, name: input.name, organizationId: input.organizationId });
  }

  // Deletes drains and returns the IDs Vercel did not delete.
  async function deleteDrains(target: { accessToken: string; teamId: string | null }, ids: string[]) {
    const results = await Promise.allSettled(ids.map((id) => dependencies.deleteVercelDrain(target, id)));
    return {
      failed: ids.filter((_id, index) => results[index]?.status === "rejected"),
      reason: results.find((result) => result.status === "rejected")?.reason as unknown,
    };
  }

  async function vercelTarget(organizationId: string, integrationAccountId: string) {
    const account = await dependencies.getAccount({ integrationAccountId, organizationId, provider: "vercel" });
    if (!account?.encryptedCredentials || account.status !== "connected") return null;
    const credentials = vercelCredentialsSchema.parse(dependencies.decrypt(account.encryptedCredentials));
    return { account, credentials };
  }

  // The connection's environments, or a response that says why they could
  // not be read.
  async function railwayEnvironmentsFor(organizationId: string, integrationAccountId: string): Promise<
    | { environments: RailwayEnvironment[]; ok: true }
    | { error: string; ok: false; status: 404 | 409 | 502 }
  > {
    try {
      const environments = await dependencies.railwayEnvironments({ integrationAccountId, organizationId });
      return environments ? { environments, ok: true } : { error: "Connect Railway first", ok: false, status: 404 };
    } catch (error) {
      if (error instanceof McpOAuthRefreshError && error.reconnectRequired) {
        return { error: "Railway refused the connection's access. Reconnect Railway.", ok: false, status: 409 };
      }
      return { error: `Railway could not list the environments: ${errorMessage(error)}`, ok: false, status: 502 };
    }
  }

  return new Hono()
    .get("/", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const [sources, accounts] = await Promise.all([
        dependencies.listSources(granted.organizationId),
        dependencies.accounts(granted.organizationId),
      ]);
      return context.json({
        accounts,
        providers: {
          gcp: dependencies.providerConfigured("gcp"),
          railway: dependencies.providerConfigured("railway"),
          vercel: dependencies.providerConfigured("vercel"),
        },
        sources,
      });
    })
    .get("/aws/template", (context) =>
      context.body(awsTelemetryCloudFormationTemplate(), 200, {
        "content-disposition": 'attachment; filename="superlog-aws-telemetry.yaml"',
        "content-type": "application/yaml; charset=utf-8",
      }),
    )
    .post("/aws", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = awsSchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return context.json({ error: "Choose a commercial AWS region" }, 400);
      const resourcePrefix = createAwsTelemetryResourcePrefix();
      const created = await sourceKey({ ...granted, name: `AWS ${body.data.region} (${resourcePrefix})` });
      const stackName = awsTelemetryStackName(resourcePrefix);
      const parameters = awsTelemetryStackParameters({
        ingestKey: created.token,
        ingestOrigin: dependencies.ingestOrigin(),
        resourcePrefix,
      });
      const saved = await dependencies.saveSource({
        createdBy: granted.userId,
        displayName: `${body.data.region} · ${stackName}`,
        externalId: resourcePrefix,
        ingestKeyId: created.key.id,
        organizationId: granted.organizationId,
        provider: "aws",
        state: { region: body.data.region, resourcePrefix, stackName },
        status: "pending",
      });
      const templateUrl = await dependencies.awsTemplateUrl().catch(() => null);
      return context.json(
        {
          deployCommand: awsTelemetryDeployCommand({ parameters, region: body.data.region, stackName }),
          launchUrl: templateUrl
            ? awsTelemetryQuickCreateUrl({ parameters, region: body.data.region, stackName, templateUrl })
            : null,
          sourceId: saved.id,
          stackName,
        },
        201,
      );
    })
    .post("/gcp", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = accountSchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return context.json({ error: "Choose a Google Cloud connection" }, 400);
      const account = await dependencies.getAccount({
        integrationAccountId: body.data.integrationAccountId,
        organizationId: granted.organizationId,
        provider: "gcp",
      });
      const credentials = account?.encryptedCredentials && account.status === "connected"
        ? gcpConnectionCredentialsSchema.safeParse(dependencies.decrypt(account.encryptedCredentials))
        : null;
      if (!credentials?.success) return context.json({ error: "Connect Google Cloud first" }, 404);
      // The worker reads with the connection's identity, so no key is made.
      const saved = await dependencies.saveSource({
        createdBy: granted.userId,
        displayName: credentials.data.projectId,
        externalId: credentials.data.projectId,
        integrationAccountId: body.data.integrationAccountId,
        organizationId: granted.organizationId,
        provider: "gcp",
        status: "pending",
      });
      return context.json({ sourceId: saved.id }, 201);
    })
    // Railway environments one connection shares, and those already read.
    .get("/railway/:integrationAccountId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const integrationAccountId = z.uuid().safeParse(context.req.param("integrationAccountId"));
      if (!integrationAccountId.success) return context.json({ error: "Connect Railway first" }, 404);
      const [listed, sources] = await Promise.all([
        railwayEnvironmentsFor(granted.organizationId, integrationAccountId.data),
        dependencies.listSources(granted.organizationId),
      ]);
      if (!listed.ok) return context.json({ error: listed.error }, listed.status);
      return context.json({
        environments: listed.environments,
        sources: sources.filter(
          (source) => source.provider === "railway" && source.integrationAccountId === integrationAccountId.data,
        ),
      });
    })
    .post("/railway", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = railwaySchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return context.json({ error: "Choose a Railway environment" }, 400);
      const listed = await railwayEnvironmentsFor(granted.organizationId, body.data.integrationAccountId);
      if (!listed.ok) return context.json({ error: listed.error }, listed.status);
      const environment = listed.environments.find((item) => item.environmentId === body.data.environmentId);
      if (!environment) return context.json({ error: "Choose an environment this Railway connection shares" }, 404);
      // The worker reads with the connection's token, so no key is made.
      const saved = await dependencies.saveSource({
        createdBy: granted.userId,
        displayName: `${environment.projectName} · ${environment.environmentName}`,
        externalId: environment.environmentId,
        integrationAccountId: body.data.integrationAccountId,
        organizationId: granted.organizationId,
        provider: "railway",
        state: {
          environmentName: environment.environmentName,
          projectId: environment.projectId,
          projectName: environment.projectName,
          services: {},
          workspaceId: environment.workspaceId,
        },
        status: "pending",
      });
      return context.json({ sourceId: saved.id }, 201);
    })
    .post("/vercel", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = accountSchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return context.json({ error: "Choose a Vercel connection" }, 400);
      const target = await vercelTarget(granted.organizationId, body.data.integrationAccountId);
      if (!target) return context.json({ error: "Connect Vercel first" }, 404);
      const created = await sourceKey({ ...granted, name: `Vercel ${target.credentials.configurationId}` });
      const projectIds = target.account.metadata.projectSelection === "selected"
        ? await dependencies.vercelProjectIds(body.data.integrationAccountId)
        : null;
      const drainTarget = { accessToken: target.credentials.accessToken, teamId: target.credentials.teamId };
      let drains: Record<string, string>;
      try {
        drains = await dependencies.createVercelDrains({
          ...drainTarget,
          ingestKey: created.token,
          ingestOrigin: dependencies.ingestOrigin(),
          name: `superlog-${granted.organizationId.slice(0, 8)}`,
          projectIds,
        });
      } catch (error) {
        await dependencies.revokeKey(created.key.id);
        const status = error instanceof VercelDrainError ? error.status : 502;
        const message = status === 403
          ? "Vercel did not allow Superlog to create drains. Drains need a Pro or Enterprise team, and the Superlog integration needs the Drains permission. Reconnect Vercel to grant it."
          : `Vercel could not create the drains: ${errorMessage(error)}`;
        return context.json({ error: message }, 502);
      }
      // Reconnecting replaces the earlier drains and key. Drains Vercel does
      // not delete now are kept and tried again later.
      const previous = (await dependencies.listSources(granted.organizationId)).find(
        (source) => source.provider === "vercel" && source.externalId === target.credentials.configurationId,
      );
      const { failed } = await deleteDrains(
        drainTarget,
        vercelDrainIds(previous?.state).filter((id) => !Object.values(drains).includes(id)),
      );
      let saved: Awaited<ReturnType<typeof dependencies.saveSource>>;
      try {
        saved = await dependencies.saveSource({
          createdBy: granted.userId,
          displayName: target.credentials.teamId ? `Vercel team ${target.credentials.teamId}` : "Vercel",
          externalId: target.credentials.configurationId,
          ingestKeyId: created.key.id,
          integrationAccountId: body.data.integrationAccountId,
          organizationId: granted.organizationId,
          provider: "vercel",
          state: { drains, staleDrains: failed },
          status: "active",
        });
      } catch (error) {
        // Unsaved drains could not be removed later, so remove them now.
        await deleteDrains(drainTarget, Object.values(drains));
        await dependencies.revokeKey(created.key.id).catch(() => undefined);
        throw error;
      }
      if (saved.previousIngestKeyId) await dependencies.revokeKey(saved.previousIngestKeyId);
      return context.json({ sourceId: saved.id }, 201);
    })
    .delete("/:sourceId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const sourceId = z.uuid().safeParse(context.req.param("sourceId"));
      const source = sourceId.success
        ? await dependencies.getSource({ id: sourceId.data, organizationId: granted.organizationId })
        : null;
      if (!source) return context.json({ error: "Source not found" }, 404);
      // As with ingest keys, members remove their own sources; owners and
      // admins remove any.
      const canRemoveAny = granted.role.split(",").some((role) => role === "admin" || role === "owner");
      if (!canRemoveAny && source.createdBy !== granted.userId) {
        return context.json({ error: "Only the source's creator, a workspace owner, or an admin can remove it" }, 403);
      }
      if (source.provider === "vercel" && source.integrationAccountId) {
        const target = await vercelTarget(granted.organizationId, source.integrationAccountId).catch(() => null);
        if (target) {
          const { failed, reason } = await deleteDrains(
            { accessToken: target.credentials.accessToken, teamId: target.credentials.teamId },
            vercelDrainIds(source.state),
          );
          if (failed.length > 0) {
            return context.json({ error: `Vercel could not remove the drains: ${errorMessage(reason)}` }, 502);
          }
        }
      }
      if (source.ingestKeyId) await dependencies.revokeKey(source.ingestKeyId);
      await dependencies.deleteSource({ id: source.id, organizationId: granted.organizationId });
      return context.body(null, 204);
    });
}
