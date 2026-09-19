import { Hono } from "hono";
import { scanConfigurationSchema } from "@responder/core/scans/config";
import { AgentConfigurationError } from "@responder/core/db/agents";
import {
  acquireScanRunLease,
  createScanInvestigationRequest,
  getScanConfiguration,
  getScanRun,
  listScanRuns,
  saveScanConfiguration,
  releaseScanRunLease,
  scanAgentConfiguration,
  ScanConfigurationError,
} from "@responder/core/db/scans";
import { SlackChannelJoinError } from "../integrations/slack.js";
import { ensureSlackChannelMemberships } from "../agents/routes.js";
import { queueInvestigation } from "../investigations/queue.js";
import { getActiveTenant } from "../tenant.js";

function scanError(error: unknown): {
  body: { error: string; code?: string };
  status: 400 | 404 | 409;
} {
  if (error instanceof ScanConfigurationError) {
    return {
      body: { error: error.message, code: error.code },
      status: error.code === "scan_already_running" ? 409 : 400,
    };
  }
  if (error instanceof AgentConfigurationError) {
    return {
      body: { error: error.message, code: error.code },
      status: error.code === "agent_not_found" ? 404 : 400,
    };
  }
  if (error instanceof SlackChannelJoinError) {
    return {
      body: { error: error.message, code: "slack_join_failed" },
      status: 400,
    };
  }
  throw error;
}

export const scanRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const [configuration, runs] = await Promise.all([
      getScanConfiguration(tenant.organizationId),
      listScanRuns(tenant.organizationId),
    ]);
    return context.json({ configuration, runs });
  })
  .put("/configuration", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const parsed = scanConfigurationSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Invalid scan configuration", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const agentConfiguration = await scanAgentConfiguration({
        organizationId: tenant.organizationId,
        configuration: parsed.data,
      });
      if (agentConfiguration) {
        await ensureSlackChannelMemberships(
          tenant.organizationId,
          agentConfiguration,
        );
      }
      const configuration = await saveScanConfiguration({
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
        configuration: parsed.data,
      });
      return context.json({ configuration });
    } catch (error) {
      const response = scanError(error);
      return context.json(response.body, response.status);
    }
  })
  .post("/runs", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    let leaseId: string | null = null;
    try {
      // Validate the configuration before acquiring the short-lived run lease
      // so an unconfigured organization gets the actionable error.
      await createScanInvestigationRequest({
        organizationId: tenant.organizationId,
        externalEventId: `manual-validation:${tenant.organizationId}`,
      });
      leaseId = await acquireScanRunLease(tenant.organizationId);
      if (!leaseId) {
        throw new ScanConfigurationError(
          "A scan is already running",
          "scan_already_running",
        );
      }
      const request = await createScanInvestigationRequest({
        organizationId: tenant.organizationId,
        externalEventId: `manual:${tenant.organizationId}:${crypto.randomUUID()}`,
      });
      const result = await queueInvestigation(request);
      if (result.kind === "paused") {
        return context.json({ accepted: false, paused: true }, 202);
      }
      if (result.kind === "blocked") {
        return context.json(
          { error: "Monthly investigation allowance exhausted" },
          402,
        );
      }
      return context.json(
        { investigationId: result.investigationId },
        result.kind === "queued" ? 202 : 200,
      );
    } catch (error) {
      if (
        error instanceof ScanConfigurationError ||
        error instanceof AgentConfigurationError ||
        error instanceof SlackChannelJoinError
      ) {
        const response = scanError(error);
        return context.json(response.body, response.status);
      }
      return context.json(
        {
          error: error instanceof Error ? error.message : "Unable to start scan",
        },
        502,
      );
    } finally {
      if (leaseId) {
        await releaseScanRunLease({
          organizationId: tenant.organizationId,
          leaseId,
        }).catch((releaseError: unknown) => {
          console.error(JSON.stringify({
            error: releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
            event: "manual_scan_lease_release_failed",
            organizationId: tenant.organizationId,
          }));
        });
      }
    }
  })
  .get("/:scanId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const scan = await getScanRun({
      organizationId: tenant.organizationId,
      scanId: context.req.param("scanId"),
    });
    if (!scan) return context.json({ error: "Scan not found" }, 404);
    return context.json({ scan });
  });
