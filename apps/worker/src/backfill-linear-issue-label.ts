import {
  decryptCredentials,
  encryptCredentials,
} from "@responder/core/credentials/encryption";
import { closeDatabase } from "@responder/core/db/client";
import { withIntegrationAccountCredentialLease } from "@responder/core/db/integrations";
import { listCreatedLinearIssuesByAccount } from "@responder/core/db/linear-tickets";
import {
  addLinearIssueLabel,
  ensureLinearIssueLabel,
  findLinearIssueLabel,
  getLinearIssueLabels,
  linearAccessTokenNeedsRefresh,
  linearIssueLabelName,
  parseLinearOAuthCredentials,
  refreshLinearOAuthCredentials,
} from "@responder/core/integrations/linear";
import { loadResponderSecrets } from "@responder/core/secrets";

// Adds the Linear issue label to issues Responder created before new issues
// carried it. Without --apply it only reports what it would change, and
// "labeled" counts the issues it would label.
const apply = process.argv.includes("--apply");

loadResponderSecrets();

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ apply, ...event }));
}

async function linearAccessToken(account: {
  id: string;
  organizationId: string;
}): Promise<string | null> {
  const credentials = await withIntegrationAccountCredentialLease({
    allowedStatuses: ["connected"],
    integrationAccountId: account.id,
    operation: async (encryptedCredentials) => {
      const current = parseLinearOAuthCredentials(
        decryptCredentials<Record<string, unknown>>(encryptedCredentials),
      );
      if (!linearAccessTokenNeedsRefresh(current)) return { value: current };
      const updated = await refreshLinearOAuthCredentials({ credentials: current });
      return {
        encryptedCredentials: encryptCredentials(updated),
        value: updated,
      };
    },
    organizationId: account.organizationId,
    provider: "linear",
  });
  return credentials?.accessToken ?? null;
}

try {
  const accounts = await listCreatedLinearIssuesByAccount();
  const labelName = linearIssueLabelName();
  const wanted = new Set(accounts.flatMap((account) => account.issueIds));
  const found = new Set<string>();
  const counts = { alreadyLabeled: 0, failed: 0, labeled: 0 };

  for (const account of accounts) {
    // An issue already found under another workspace is not asked again.
    const issueIds = account.issueIds.filter((issueId) => !found.has(issueId));
    if (issueIds.length === 0) continue;

    let accessToken: string | null;
    try {
      accessToken = await linearAccessToken(account);
    } catch (error) {
      log({
        accountId: account.id,
        error: error instanceof Error ? error.message : "credentials unavailable",
        event: "linear_label_backfill_account_failed",
      });
      continue;
    }
    if (!accessToken) continue;

    const labelIdsByTeam = new Map<string, string | null>();
    for (const issueId of issueIds) {
      try {
        const issue = await getLinearIssueLabels({ accessToken, issueId });
        if (!issue) continue;
        found.add(issueId);
        let labelId = labelIdsByTeam.get(issue.teamId);
        if (labelId === undefined) {
          const lookup = { accessToken, name: labelName, teamId: issue.teamId };
          labelId = apply
            ? await ensureLinearIssueLabel(lookup)
            : await findLinearIssueLabel(lookup);
          labelIdsByTeam.set(issue.teamId, labelId);
        }
        if (labelId && issue.labelIds.includes(labelId)) {
          counts.alreadyLabeled += 1;
          continue;
        }
        if (apply && labelId) {
          await addLinearIssueLabel({ accessToken, issueId, labelId });
        }
        counts.labeled += 1;
        log({
          accountId: account.id,
          event: "linear_label_backfill_issue",
          identifier: issue.identifier,
          labelExists: Boolean(labelId),
        });
      } catch (error) {
        counts.failed += 1;
        log({
          accountId: account.id,
          error: error instanceof Error ? error.message : "request failed",
          event: "linear_label_backfill_issue_failed",
          issueId,
        });
      }
    }
  }

  log({
    ...counts,
    event: "linear_label_backfill_finished",
    label: labelName,
    notFound: [...wanted].filter((issueId) => !found.has(issueId)),
  });
} finally {
  await closeDatabase();
}
