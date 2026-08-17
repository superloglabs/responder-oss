import { Agent, run, setDefaultOpenAIKey, setTracingDisabled } from "@openai/agents";
import { getRuntimeLinearConnection } from "@responder/core/db/investigations";
import { listPendingLinearTicketRequests } from "@responder/core/db/linear-tickets";
import type { LinearTicketJob } from "@responder/core/jobs";
import { linearTicketFollowupInstruction } from "@responder/core/integrations/linear";
import { createLinearMcpServer } from "./custom-mcp.js";
import { createLinearTicketTool } from "./linear-ticket.js";

export async function runLinearTicketJob(
  job: LinearTicketJob,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const openAiApiKey = environment.OPENAI_API_KEY;
  if (!openAiApiKey) throw new Error("OPENAI_API_KEY is required");
  const pending = await listPendingLinearTicketRequests({
    investigationId: job.investigationId,
    organizationId: job.config.organizationId,
  });
  const request = pending.find((candidate) => candidate.requestId === job.requestId);
  if (!request) return;
  const connection = await getRuntimeLinearConnection(
    job.config.id,
    request.integrationAccountId,
  );
  if (!connection) throw new Error("The Linear connection is unavailable");
  const instruction = linearTicketFollowupInstruction({ requests: [request] });
  if (!instruction) return;

  setDefaultOpenAIKey(openAiApiKey);
  setTracingDisabled(true);
  const server = createLinearMcpServer(connection);
  try {
    await server.connect();
    const agent = new Agent({
      name: "Responder Linear ticket creator",
      model: environment.OPENAI_MODEL?.trim() || "gpt-5.6-sol",
      instructions: [
        "Create the required Linear ticket for the saved investigation.",
        instruction,
        "Do not change any Linear data except through create_linear_ticket.",
      ].join("\n\n"),
      mcpServers: [server],
      tools: [createLinearTicketTool({
        agentConfigVersionId: job.config.id,
        investigationId: job.investigationId,
        organizationId: job.config.organizationId,
      })],
    });
    await run(agent, "Create the required Linear ticket now.", { maxTurns: 10 });
    const remaining = await listPendingLinearTicketRequests({
      investigationId: job.investigationId,
      organizationId: job.config.organizationId,
    });
    if (remaining.some((candidate) => candidate.requestId === job.requestId)) {
      throw new Error("The Linear ticket was not created");
    }
  } finally {
    await server.close().catch(() => undefined);
  }
}
