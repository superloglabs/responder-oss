import { closeDatabase } from "@responder/core/db/client";
import {
  prepareInvestigationRetry,
  InvestigationRetryError,
} from "@responder/core/db/investigations";
import {
  createJobBoss,
  investigationQueue,
  prepareWorkerQueues,
} from "@responder/core/jobs";
import { loadResponderSecrets } from "@responder/core/secrets";
import { z } from "zod";

const investigationIdSchema = z.uuid();
const expectedFailureReason =
  "Duplicate tool names found across MCP servers";
const investigationIds = process.argv.slice(2).map((value) =>
  investigationIdSchema.parse(value),
);

if (investigationIds.length === 0) {
  throw new Error(
    "Usage: backfill-mcp-tool-collision <failed-investigation-id> [...]",
  );
}

loadResponderSecrets();
const boss = createJobBoss();

try {
  await boss.start();
  await prepareWorkerQueues(boss);

  for (const investigationId of investigationIds) {
    try {
      const retry = await prepareInvestigationRetry(investigationId, {
        expectedFailureReason,
      });
      const jobId = await boss.send(
        investigationQueue,
        {
          kind: "investigation",
          config: retry.config,
          investigationId: retry.investigationId,
          queuedAt: new Date().toISOString(),
          request: {
            agentId: retry.config.agentId,
            body: retry.input.body,
            externalEventId: retry.input.externalEventId,
            provider: retry.input.provider,
            title: retry.input.title,
            ...(retry.input.sourceUrl
              ? { sourceUrl: retry.input.sourceUrl }
              : {}),
            ...(retry.input.attributes
              ? { attributes: retry.input.attributes }
              : {}),
          },
          runtimeProfileId: retry.runtimeProfileId,
        },
        { singletonKey: `mcp-tool-collision-backfill:${investigationId}` },
      );
      if (!jobId) throw new Error("The backfill job was not created");
      console.log(
        JSON.stringify({
          event: "mcp_tool_collision_backfill_queued",
          investigationId,
          jobId,
        }),
      );
    } catch (error) {
      if (error instanceof InvestigationRetryError) {
        console.error(
          JSON.stringify({
            code: error.code,
            error: error.message,
            event: "mcp_tool_collision_backfill_skipped",
            investigationId,
          }),
        );
        continue;
      }
      throw error;
    }
  }
} finally {
  await boss.stop({ graceful: true, timeout: 10_000 });
  await closeDatabase();
}
