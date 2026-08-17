import { and, eq, inArray, sql } from "drizzle-orm";
import {
  createLinearIssue,
  findLinearIssueById,
  renderLinearIssueDescription,
} from "../integrations/linear.js";
import { getDatabase } from "./client.js";
import { getRuntimeLinearConnection } from "./investigations.js";
import {
  agentConfigVersions,
  investigations,
  issueLinearTickets,
  issues,
} from "./schema.js";

export class LinearTicketError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "request_not_found"
      | "request_not_active"
      | "connection_unavailable",
  ) {
    super(message);
    this.name = "LinearTicketError";
  }
}

export async function listPendingLinearTicketRequests(input: {
  investigationId: string;
  organizationId: string;
}) {
  return getDatabase()
    .select({
      requestId: issueLinearTickets.id,
      issueId: issues.id,
      title: issues.title,
      description: issues.description,
      severity: issues.severity,
    })
    .from(issueLinearTickets)
    .innerJoin(issues, eq(issues.id, issueLinearTickets.issueId))
    .innerJoin(
      investigations,
      eq(investigations.id, issueLinearTickets.investigationId),
    )
    .where(
      and(
        eq(issueLinearTickets.investigationId, input.investigationId),
        eq(investigations.organizationId, input.organizationId),
        inArray(issueLinearTickets.status, ["pending", "creating", "failed"]),
      ),
    )
    .orderBy(issueLinearTickets.createdAt);
}

async function getLinearTicketRequest(input: {
  agentConfigVersionId: string;
  investigationId: string;
  organizationId: string;
  requestId: string;
}) {
  const rows = await getDatabase()
    .select({
      id: issueLinearTickets.id,
      status: issueLinearTickets.status,
      integrationAccountId: issueLinearTickets.integrationAccountId,
      title: issues.title,
      description: issues.description,
      severity: issues.severity,
      remediation: issues.remediation,
      evidence: issues.evidence,
      issueId: issues.id,
      linearIssueTemplate: agentConfigVersions.linearIssueTemplate,
      linearIssueId: issueLinearTickets.linearIssueId,
      linearIdentifier: issueLinearTickets.linearIdentifier,
      linearIssueUrl: issueLinearTickets.linearIssueUrl,
    })
    .from(issueLinearTickets)
    .innerJoin(issues, eq(issues.id, issueLinearTickets.issueId))
    .innerJoin(
      investigations,
      eq(investigations.id, issueLinearTickets.investigationId),
    )
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, issueLinearTickets.agentConfigVersionId),
    )
    .where(
      and(
        eq(issueLinearTickets.id, input.requestId),
        eq(issueLinearTickets.investigationId, input.investigationId),
        eq(issueLinearTickets.agentConfigVersionId, input.agentConfigVersionId),
        eq(investigations.organizationId, input.organizationId),
        eq(issues.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function fulfillLinearTicketRequest(input: {
  agentConfigVersionId: string;
  investigationId: string;
  issueBaseUrl?: string;
  organizationId: string;
  projectId?: string;
  requestId: string;
  teamId: string;
}) {
  const request = await getLinearTicketRequest(input);
  if (!request) {
    throw new LinearTicketError("Linear ticket request not found", "request_not_found");
  }
  if (
    request.status === "created" &&
    request.linearIssueId &&
    request.linearIdentifier &&
    request.linearIssueUrl
  ) {
    return {
      id: request.linearIssueId,
      identifier: request.linearIdentifier,
      url: request.linearIssueUrl,
    };
  }

  const claimed = await getDatabase()
    .update(issueLinearTickets)
    .set({
      status: "creating",
      teamId: input.teamId,
      projectId: input.projectId ?? null,
      failureReason: null,
      attemptCount: sql`${issueLinearTickets.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issueLinearTickets.id, request.id),
        inArray(issueLinearTickets.status, ["pending", "creating", "failed"]),
      ),
    )
    .returning({ id: issueLinearTickets.id });
  if (!claimed[0]) {
    throw new LinearTicketError(
      "Linear ticket request is no longer active",
      "request_not_active",
    );
  }

  try {
    const connection = await getRuntimeLinearConnection(input.agentConfigVersionId);
    if (
      !connection ||
      connection.accountId !== request.integrationAccountId
    ) {
      throw new LinearTicketError(
        "The Linear connection for this request is unavailable",
        "connection_unavailable",
      );
    }
    let created;
    try {
      created = await createLinearIssue({
        accessToken: connection.accessToken,
        description: renderLinearIssueDescription({
          issue: {
            id: request.issueId,
            title: request.title,
            description: request.description,
            severity: request.severity,
            remediation: request.remediation,
            evidence: request.evidence,
          },
          issueBaseUrl: input.issueBaseUrl ??
            process.env.BETTER_AUTH_URL ??
            "http://localhost:3000",
          template: request.linearIssueTemplate,
        }),
        id: request.id,
        projectId: input.projectId,
        teamId: input.teamId,
        title: request.title,
      });
    } catch (creationError) {
      try {
        created = await findLinearIssueById({
          accessToken: connection.accessToken,
          issueId: request.id,
        });
      } catch {
        throw creationError;
      }
    }
    if (!created) throw new Error("Linear did not return the created issue");
    await getDatabase()
      .update(issueLinearTickets)
      .set({
        status: "created",
        linearIssueId: created.id,
        linearIdentifier: created.identifier,
        linearIssueUrl: created.url,
        failureReason: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issueLinearTickets.id, request.id));
    return created;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Linear ticket creation failed";
    await getDatabase()
      .update(issueLinearTickets)
      .set({
        status: "failed",
        failureReason: message.slice(0, 2_000),
        updatedAt: new Date(),
      })
      .where(eq(issueLinearTickets.id, request.id));
    throw error;
  }
}
