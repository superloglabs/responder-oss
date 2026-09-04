import {
  failCodebaseKnowledgeGeneration,
  getCodebaseKnowledgeRefreshTarget,
  listCodebaseKnowledgeRefreshTargets,
  listCodebaseKnowledgeRefreshTargetsForAgent,
  markCodebaseKnowledgeQueued,
  type CodebaseKnowledgeRefreshTarget,
} from "./db/knowledge-base.js";
import {
  codebaseKnowledgeQueue,
  type CodebaseKnowledgeJob,
} from "./jobs.js";

export interface CodebaseKnowledgeJobQueue {
  send(
    name: string,
    data: CodebaseKnowledgeJob,
    options: { singletonKey: string },
  ): Promise<string | null>;
}

export async function queueCodebaseKnowledgeTarget(
  queue: CodebaseKnowledgeJobQueue,
  target: CodebaseKnowledgeRefreshTarget,
  force = false,
): Promise<{ jobId: string | null; target: CodebaseKnowledgeRefreshTarget }> {
  await markCodebaseKnowledgeQueued(target);
  try {
    const jobId = await queue.send(
      codebaseKnowledgeQueue,
      {
        kind: "codebase_knowledge_refresh",
        force,
        organizationId: target.organizationId,
        repositoryId: target.repositoryId,
        requestedAt: new Date().toISOString(),
      },
      {
        singletonKey: force
          ? `codebase-knowledge-force:${target.repositoryId}`
          : `codebase-knowledge:${target.repositoryId}`,
      },
    );
    return { jobId, target };
  } catch (error) {
    await failCodebaseKnowledgeGeneration({
      repositoryId: target.repositoryId,
      failureReason: error instanceof Error ? error.message : "Unable to queue refresh",
    });
    throw error;
  }
}

export async function queueCodebaseKnowledgeRefresh(input: {
  force?: boolean;
  organizationId: string;
  queue: CodebaseKnowledgeJobQueue;
  repositoryId: string;
}) {
  const target = await getCodebaseKnowledgeRefreshTarget(input);
  if (!target) return null;
  return queueCodebaseKnowledgeTarget(input.queue, target, input.force);
}

export async function queueCodebaseKnowledgeRefreshesForAgent(input: {
  agentId: string;
  organizationId: string;
  queue: CodebaseKnowledgeJobQueue;
}) {
  const targets = await listCodebaseKnowledgeRefreshTargetsForAgent(input);
  return Promise.all(
    targets.map((target) => queueCodebaseKnowledgeTarget(input.queue, target)),
  );
}

export async function queueDailyCodebaseKnowledgeRefreshes(
  queue: CodebaseKnowledgeJobQueue,
) {
  const targets = await listCodebaseKnowledgeRefreshTargets();
  return Promise.all(
    targets.map((target) => queueCodebaseKnowledgeTarget(queue, target)),
  );
}
