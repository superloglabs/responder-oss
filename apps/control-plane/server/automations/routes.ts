import { listSubscriptionModels } from "./subscription-models.js";
import { listProviderModels, ModelCatalogError } from "../../../../packages/core/src/automations/model-catalog.js";
import { getOrganizationModelCredential } from "../../../../packages/core/src/db/automation-model-credentials.js";
import type { AutomationModelProvider } from "../../../../packages/core/src/automations/config.js";
import { SubscriptionLoginError, subscriptionLoginTransport } from "./subscription-login.js";
import { startModelSubscription, pollModelSubscription, cancelModelSubscription } from "../../../../packages/core/src/db/model-subscriptions.js";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  automationInputSchema,
  automationModelProviderSchema,
} from "../../../../packages/core/src/automations/config.js";
import {
  AutomationConfigurationError,
  createAutomation,
  getAutomation,
  getAutomationRun,
  listAutomations,
  requestAutomationRunCancellation,
  setAutomationEnabled,
  updateAutomation,
} from "../../../../packages/core/src/db/automations.js";
import { listAgentOptions } from "../../../../packages/core/src/db/agents.js";
import {
  createOrganizationModelCredential,
  deleteOrganizationModelCredential,
  getOrganizationModelCredentialForValidation,
  listOrganizationModelCredentials,
  markOrganizationModelCredentialValidated,
  rotateOrganizationModelCredential,
} from "../../../../packages/core/src/db/automation-model-credentials.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { getActiveTenant } from "../tenant.js";
import { queueAutomationRun } from "./queue.js";

const automationEnabledSchema = z.object({ enabled: z.boolean() });
const credentialInputSchema = z.object({
  apiKey: z.string().min(1).max(4_096),
  label: z.string().trim().min(1).max(120),
  provider: automationModelProviderSchema,
});
const credentialRotationSchema = z.object({
  apiKey: z.string().min(1).max(4_096),
});
const credentialTestSchema = z.object({
  model: z.string().trim().min(1).max(255),
});

type AutomationTenant = {
  organizationId: string;
  user: { id: string };
};

async function getAutomationTenant(
  headers: Headers,
): Promise<
  | { ok: true; tenant: AutomationTenant }
  | { ok: false; error: string; status: 401 | 403 | 404 | 409 }
> {
  const tenant = await getActiveTenant(headers);
  if (tenant.ok === false) return tenant;
  if (!(await organizationHasCapability(tenant.organizationId, "automations"))) {
    return { ok: false, error: "Not found", status: 404 };
  }
  return { ok: true, tenant };
}

function configurationError(error: unknown): {
  body: { code?: string; error: string };
  status: 400 | 404;
} {
  if (error instanceof AutomationConfigurationError) {
    return {
      body: { code: error.code, error: error.message },
      status: error.code === "automation_not_found" ? 404 : 400,
    };
  }
  throw error;
}

async function testProviderCredential(input: {
  apiKey: string;
  model: string;
  provider: AutomationModelProvider;
}): Promise<{ authenticationFailed: boolean; valid: boolean }> {
  try {
    const models = await listProviderModels(input.provider, input.apiKey);
    return { authenticationFailed: false, valid: models.some(model => model.id === input.model) };
  } catch (error) {
    if (error instanceof ModelCatalogError && error.authenticationFailed) return { authenticationFailed: true, valid: false };
    throw error;
  }
}

export const automationRoutes = new Hono()
  .get("/credentials/:credentialId/models", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const credentialId = context.req.param("credentialId");
    if (!z.string().uuid().safeParse(credentialId).success) return context.json({ error: "Invalid connection" }, 400);
    context.header("Cache-Control", "no-store");
    const credential = await getOrganizationModelCredential({ credentialId, organizationId: access.tenant.organizationId });
    if (!credential) return context.json({ error: "Connection not found" }, 404);
    try {
      const models = credential.subscription
        ? await listSubscriptionModels({ credentialId, organizationId: access.tenant.organizationId }, context.req.query("refresh") === "true")
        : await listProviderModels(credential.provider, credential.apiKey);
      return context.json({ models });
    } catch (error) {
      return context.json({ error: error instanceof ModelCatalogError ? error.message : "Unable to load models. Please retry when this connection is idle." }, 502);
    }
  })
  .post("/subscriptions/openai", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    context.header("Cache-Control", "no-store");
    try { return context.json(await startModelSubscription({ organizationId: access.tenant.organizationId, userId: access.tenant.user.id }, subscriptionLoginTransport)); }
    catch { return context.json({ error: "Unable to start ChatGPT sign-in. Try again." }, 502); }
  })
  .post("/subscriptions/openai/:connectionId/poll", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    if (!z.string().uuid().safeParse(context.req.param("connectionId")).success) return context.json({ error: "Invalid connection" }, 400);
    context.header("Cache-Control", "no-store");
    try { return context.json(await pollModelSubscription({ organizationId: access.tenant.organizationId, userId: access.tenant.user.id, connectionId: context.req.param("connectionId") }, subscriptionLoginTransport)); }
    catch (error) {
      const failure = error instanceof SubscriptionLoginError ? error : null;
      // Never log exception messages or request bodies: they may contain credentials.
      console.error(JSON.stringify({ event: "subscription_poll_failed", stage: failure?.stage ?? "storage", retryable: failure?.retryable ?? true }));
      if (failure && !failure.retryable) return context.json({ status: "failed" as const, error: failure.message });
      return context.json({ error: "Unable to check ChatGPT sign-in. Please try again." }, 502);
    }
  })
  .delete("/subscriptions/openai/:connectionId", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    if (!z.string().uuid().safeParse(context.req.param("connectionId")).success) return context.json({ error: "Invalid connection" }, 400);
    await cancelModelSubscription({ organizationId: access.tenant.organizationId, userId: access.tenant.user.id, connectionId: context.req.param("connectionId") }, subscriptionLoginTransport);
    return context.json({ ok: true });
  })
  .get("/", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    return context.json({
      automations: await listAutomations(access.tenant.organizationId),
    });
  })
  .get("/options", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const [options, credentials] = await Promise.all([
      listAgentOptions(access.tenant.organizationId),
      listOrganizationModelCredentials(access.tenant.organizationId),
    ]);
    return context.json({
      ...options,
      accounts: options.accounts.filter((account) =>
        [
          "discord",
          "github",
          "slack",
          "sentry",
          "datadog",
          "posthog",
          "custom_mcp",
        ].includes(account.provider)
      ),
      credentials,
    });
  })
  .get("/credentials", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    return context.json({
      credentials: await listOrganizationModelCredentials(
        access.tenant.organizationId,
      ),
    });
  })
  .post("/credentials", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const parsed = credentialInputSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Invalid model credential", issues: parsed.error.issues },
        400,
      );
    }
    try { await listProviderModels(parsed.data.provider, parsed.data.apiKey); }
    catch (error) { return context.json({ error: error instanceof ModelCatalogError ? error.message : "Unable to verify the provider connection. Please retry." }, error instanceof ModelCatalogError && error.authenticationFailed ? 400 : 503); }
    const credential = await createOrganizationModelCredential({
      ...parsed.data,
      organizationId: access.tenant.organizationId,
    });
    return context.json({ credentialId: credential.id }, 201);
  })
  .put("/credentials/:credentialId", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const parsed = credentialRotationSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({ error: "Invalid model credential" }, 400);
    }
    const updated = await rotateOrganizationModelCredential({
      apiKey: parsed.data.apiKey,
      credentialId: context.req.param("credentialId"),
      organizationId: access.tenant.organizationId,
    });
    return updated
      ? context.json({ updated: true })
      : context.json({ error: "Model credential not found" }, 404);
  })
  .post("/credentials/:credentialId/test", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const parsed = credentialTestSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return context.json({ error: "Invalid model" }, 400);
    const credential = await getOrganizationModelCredentialForValidation({
      credentialId: context.req.param("credentialId"),
      organizationId: access.tenant.organizationId,
    });
    if (!credential) {
      return context.json({ error: "Model credential not found" }, 404);
    }
    let result: { authenticationFailed: boolean; valid: boolean };
    try {
      result = await testProviderCredential({
        ...credential,
        model: parsed.data.model,
      });
    } catch {
      return context.json({ error: "Model provider is temporarily unavailable" }, 503);
    }
    if (result.valid || result.authenticationFailed) {
      await markOrganizationModelCredentialValidated({
        credentialId: context.req.param("credentialId"),
        encryptedCredentials: credential.encryptedCredentials,
        organizationId: access.tenant.organizationId,
        valid: result.valid,
      });
    }
    return context.json(
      { authenticationFailed: result.authenticationFailed, valid: result.valid },
      result.valid ? 200 : 422,
    );
  })
  .delete("/credentials/:credentialId", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    try {
      const deleted = await deleteOrganizationModelCredential({
        credentialId: context.req.param("credentialId"),
        organizationId: access.tenant.organizationId,
      });
      return deleted
        ? context.json({ deleted: true })
        : context.json({ error: "Model credential not found" }, 404);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23503"
      ) {
        return context.json({ error: "Model credential is in use" }, 409);
      }
      throw error;
    }
  })
  .post("/", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const parsed = automationInputSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Invalid automation", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const automation = await createAutomation(
        access.tenant.organizationId,
        access.tenant.user.id,
        parsed.data,
      );
      return context.json({ automationId: automation.id }, 201);
    } catch (error) {
      const response = configurationError(error);
      return context.json(response.body, response.status);
    }
  })
  .get("/runs/:runId", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const run = await getAutomationRun(
      access.tenant.organizationId,
      context.req.param("runId"),
    );
    return run
      ? context.json({ run })
      : context.json({ error: "Automation run not found" }, 404);
  })
  .post("/runs/:runId/cancel", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const cancelled = await requestAutomationRunCancellation({
      organizationId: access.tenant.organizationId,
      runId: context.req.param("runId"),
    });
    return cancelled
      ? context.json({ cancelRequested: true })
      : context.json({ error: "Automation run is not active" }, 409);
  })
  .get("/:automationId", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const automation = await getAutomation(
      access.tenant.organizationId,
      context.req.param("automationId"),
    );
    return automation
      ? context.json({ automation })
      : context.json({ error: "Automation not found" }, 404);
  })
  .put("/:automationId", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const parsed = automationInputSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Invalid automation", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const updated = await updateAutomation(
        access.tenant.organizationId,
        context.req.param("automationId"),
        access.tenant.user.id,
        parsed.data,
      );
      return updated
        ? context.json({ updated: true })
        : context.json({ error: "Automation not found" }, 404);
    } catch (error) {
      const response = configurationError(error);
      return context.json(response.body, response.status);
    }
  })
  .patch("/:automationId", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const parsed = automationEnabledSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return context.json({ error: "Invalid status" }, 400);
    const updated = await setAutomationEnabled({
      automationId: context.req.param("automationId"),
      enabled: parsed.data.enabled,
      organizationId: access.tenant.organizationId,
    });
    return updated
      ? context.json({ enabled: parsed.data.enabled })
      : context.json({ error: "Automation not found" }, 404);
  })
  .post("/:automationId/runs", async (context) => {
    const access = await getAutomationTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const automation = await getAutomation(
      access.tenant.organizationId,
      context.req.param("automationId"),
    );
    if (!automation) return context.json({ error: "Automation not found" }, 404);
    try {
      const run = await queueAutomationRun({
        automationId: automation.id,
        trigger: {
          body: "Manual run requested from the Automations page.",
          externalEventId: `manual:${randomUUID()}`,
          provider: "manual",
          title: "Manual run",
        },
      });
      return context.json(run, run.duplicate ? 200 : 202);
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error ? error.message : "Unable to queue automation",
        },
        503,
      );
    }
  });
