import {
  queueCodebaseKnowledgeRefresh,
  queueCodebaseKnowledgeRefreshesForAgent,
} from "@responder/core/knowledge-base-queue";
import {
  type CodebaseKnowledgeJob,
} from "@responder/core/jobs";
import { getControlPlaneJobBoss } from "../investigations/queue.js";

function jobQueue(queue: Awaited<ReturnType<typeof getControlPlaneJobBoss>>) {
  return {
    send: (
      name: string,
      data: CodebaseKnowledgeJob,
      options: { singletonKey: string },
    ) => queue.send(name, data, options),
  };
}

export async function requestCodebaseKnowledgeRefresh(input: {
  force?: boolean;
  organizationId: string;
  repositoryId: string;
}) {
  const queue = await getControlPlaneJobBoss();
  return queueCodebaseKnowledgeRefresh({
    ...input,
    queue: jobQueue(queue),
  });
}

export async function requestCodebaseKnowledgeRefreshesForAgent(input: {
  agentId: string;
  organizationId: string;
}) {
  const queue = await getControlPlaneJobBoss();
  return queueCodebaseKnowledgeRefreshesForAgent({
    ...input,
    queue: jobQueue(queue),
  });
}
