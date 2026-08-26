import { closeDatabase } from "@responder/core/db/client";
import { redeliverInvestigationSlackIssue } from "@responder/core/integrations/slack-delivery";
import { loadResponderSecrets } from "@responder/core/secrets";
import { z } from "zod";

const targetSchema = z.object({
  investigationId: z.uuid(),
  issueId: z.uuid(),
});

function parseTarget(value: string) {
  const [investigationId, issueId, ...extra] = value.split(":");
  if (extra.length > 0) {
    throw new Error(`Invalid Slack issue backfill target: ${value}`);
  }
  return targetSchema.parse({ investigationId, issueId });
}

const [deliveryRunId, ...targetValues] = process.argv.slice(2);
if (!deliveryRunId || targetValues.length === 0) {
  throw new Error(
    "Usage: backfill-slack-issues <delivery-run-id> <investigation-id:issue-id> [...]",
  );
}

loadResponderSecrets();

try {
  for (const targetValue of targetValues) {
    const target = parseTarget(targetValue);
    const result = await redeliverInvestigationSlackIssue({
      deliveryRunId,
      ...target,
    });
    console.log(JSON.stringify({
      deliveryRunId,
      event: "slack_issue_backfill_complete",
      investigationId: target.investigationId,
      ...result,
    }));
  }
} finally {
  await closeDatabase();
}
