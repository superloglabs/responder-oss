import { run, setDefaultOpenAIKey, setTracingDisabled, tool } from "@openai/agents";
import { Capabilities, SandboxAgent } from "@openai/agents/sandbox";
import { DaytonaSandboxClient } from "@openai/agents-extensions/sandbox/daytona";
import {
  completeCodebaseKnowledgeGeneration,
  failCodebaseKnowledgeGeneration,
  getCodebaseKnowledgeRefreshTarget,
  getRepositoryCodebaseKnowledge,
  markCodebaseKnowledgeCurrent,
  markCodebaseKnowledgeGenerating,
  markCodebaseKnowledgeObsolete,
} from "@responder/core/db/knowledge-base";
import type { CodebaseKnowledgeJob } from "@responder/core/jobs";
import {
  codebaseKnowledgeContentSchema,
  sanitizeCodebaseKnowledgeContent,
  type CodebaseKnowledgeContent,
  type CodebaseKnowledgeRepositoryRevision,
} from "@responder/core/knowledge-base";
import { daytonaClientOptions } from "@responder/core/daytona-config";
import {
  checkoutRepositoryAtRef,
  resolveRepositoryHead,
} from "./repositories.js";
import {
  closeDaytonaSandbox,
  configureDaytonaSandboxLifecycle,
  createDaytonaSandboxSession,
  prepareDaytonaSandbox,
} from "./sandbox.js";
import { sandboxAgentConfig, safeInvestigationError } from "./investigate.js";

type RefreshJob = Extract<
  CodebaseKnowledgeJob,
  { kind: "codebase_knowledge_refresh" }
>;

export function repositoryRevisionsMatch(
  left: readonly CodebaseKnowledgeRepositoryRevision[],
  right: readonly CodebaseKnowledgeRepositoryRevision[],
): boolean {
  if (left.length !== right.length) return false;
  const normalize = (revisions: readonly CodebaseKnowledgeRepositoryRevision[]) =>
    [...revisions].sort((a, b) => a.repository.localeCompare(b.repository));
  const normalizedRight = normalize(right);
  return normalize(left).every((revision, index) => {
    const candidate = normalizedRight[index];
    return candidate !== undefined &&
      revision.repository === candidate.repository &&
      revision.branch === candidate.branch &&
      revision.sha === candidate.sha;
  });
}

export function codebaseKnowledgeInstructions(
  revision: CodebaseKnowledgeRepositoryRevision,
): string {
  return [
    "Create a durable codebase knowledge base for engineers and incident investigators.",
    "Inspect the checked-out repository deeply. Read repository instruction files first. Base every statement on source, configuration, tests, or checked-in documentation; do not invent behavior.",
    `The snapshot describes ${revision.repository}@${revision.sha}.`,
    "Submit 8–12 complementary Markdown documents. Aim for about 10. Cover: system overview, architecture and boundaries, major components, request and background-job flows, data model, authentication and security, external integrations, deployment and operations, testing, and safe extension points. Avoid repeating the same prose across documents.",
    "Each document must stand alone, name concrete files and symbols, explain why the design exists, and list its most useful source paths as repository-relative paths prefixed with the repository name.",
    "Submit 8–12 complementary D2 diagrams. Aim for about 10. Cover system context, containers, request sequence, investigation pipeline, data relationships, identity/tenancy, repository checkout, integration boundaries, deployment, and retries/failure recovery where the source supports them.",
    "D2 must use the restricted syntax understood by the UI: one node declaration per line as `node_id: Human label`, then edges as `source_id -> target_id: Optional label`. IDs use lowercase letters, digits, and underscores and every edge endpoint must be declared. Blank lines and # comments are allowed. Do not use containers, styles, shapes, semicolons, markdown fences, or other D2 features.",
    "Keep diagrams readable: usually 4–12 nodes, with short labels. Source paths must support the depicted relationships.",
    "Do not include credentials, secret values, generated dependencies, or speculation. Do not modify the repositories.",
    "Call submit_codebase_knowledge exactly once after completing the full set. Then return a one-sentence completion note.",
  ].join("\n\n");
}

export function createCodebaseKnowledgeSubmissionTool(
  onSubmit: (content: CodebaseKnowledgeContent) => void,
) {
  return tool({
    name: "submit_codebase_knowledge",
    description:
      "Submit the complete, source-grounded Markdown and D2 codebase knowledge snapshot exactly once.",
    parameters: codebaseKnowledgeContentSchema,
    execute(content) {
      onSubmit(content);
      return {
        accepted: true,
        diagramCount: content.diagrams.length,
        documentCount: content.documents.length,
      };
    },
  });
}

export async function runCodebaseKnowledgeRefresh(
  job: RefreshJob,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ generated: boolean; reason?: "unchanged" | "obsolete" }> {
  const currentTarget = await getCodebaseKnowledgeRefreshTarget({
    organizationId: job.organizationId,
    repositoryId: job.repositoryId,
  });
  if (!currentTarget) {
    await markCodebaseKnowledgeObsolete(job.repositoryId);
    return { generated: false, reason: "obsolete" };
  }

  let revision: CodebaseKnowledgeRepositoryRevision;
  try {
    revision = await resolveRepositoryHead(currentTarget);
  } catch (error) {
    await failCodebaseKnowledgeGeneration({
      repositoryId: job.repositoryId,
      failureReason: safeInvestigationError(error, environment),
    });
    throw error;
  }
  const existing = await getRepositoryCodebaseKnowledge(job.repositoryId);
  if (
    !job.force &&
    existing &&
    repositoryRevisionsMatch(existing.repositoryRevisions, [revision])
  ) {
    await markCodebaseKnowledgeCurrent({
      repositoryId: job.repositoryId,
    });
    return { generated: false, reason: "unchanged" };
  }

  if (!(await markCodebaseKnowledgeGenerating(currentTarget))) {
    return { generated: false, reason: "obsolete" };
  }

  const sandboxName = `responder-codebase-knowledge-${job.repositoryId}`;
  let config: ReturnType<typeof sandboxAgentConfig> | null = null;
  let session: Awaited<ReturnType<typeof createDaytonaSandboxSession>> | null = null;
  try {
    config = sandboxAgentConfig(environment);
    setDefaultOpenAIKey(config.openAiApiKey);
    setTracingDisabled(true);
    const client = new DaytonaSandboxClient({
      ...daytonaClientOptions(config),
      name: sandboxName,
    });
    session = await createDaytonaSandboxSession(client, config, sandboxName);
    await configureDaytonaSandboxLifecycle(session, config);
    if (!config.sandboxSnapshotName) await prepareDaytonaSandbox(session);
    await checkoutRepositoryAtRef(
      session,
      currentTarget,
      { branch: revision.branch, sha: revision.sha },
    );

    let submission: CodebaseKnowledgeContent | null = null;
    const submissionTool = createCodebaseKnowledgeSubmissionTool((content) => {
      if (submission) throw new Error("Codebase knowledge was already submitted");
      submission = content;
    });
    const agent = new SandboxAgent({
      name: "Responder codebase cartographer",
      model: config.model,
      instructions: codebaseKnowledgeInstructions(revision),
      capabilities: Capabilities.default(),
      tools: [submissionTool],
    });
    await run(agent, "Build the codebase knowledge snapshot now.", {
      maxTurns: 60,
      sandbox: { session },
    });
    if (!submission) {
      throw new Error("The model did not submit a codebase knowledge snapshot");
    }
    await completeCodebaseKnowledgeGeneration({
      content: sanitizeCodebaseKnowledgeContent(submission),
      repositoryId: job.repositoryId,
      repositoryRevision: revision,
    });
    return { generated: true };
  } catch (error) {
    await failCodebaseKnowledgeGeneration({
      repositoryId: job.repositoryId,
      failureReason: safeInvestigationError(error, environment),
    });
    throw error;
  } finally {
    if (session && config) {
      await closeDaytonaSandbox(session, config, {
        organizationId: job.organizationId,
      });
    }
  }
}
