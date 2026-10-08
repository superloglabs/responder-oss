import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeAwsConnection } from "@responder/core/db/investigations";
import { AWS_MANAGED_MCP_ENDPOINT } from "@responder/core/integrations/aws";
import {
  AWS_MCP_REQUEST_TIMEOUT_MS,
  createAwsMcpFetch,
  createRefreshingAwsCredentialsProvider,
  isAwsReadOnlyMcpTool,
} from "@responder/core/integrations/aws-mcp";

export const AWS_ALARM_SKILL_NAMES = [
  "aws-observability",
  "aws-messaging-and-streaming",
  "aws-serverless",
] as const;

export interface AwsAlarmSkillContext {
  content: string;
  failures: Array<{ error: string; skillName: string }>;
}

export function awsReadOnlyToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  return Promise.resolve(isAwsReadOnlyMcpTool(
    tool as { annotations?: { readOnlyHint?: boolean }; name?: string },
  ));
}

function managedSkillContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (
      !item ||
      typeof item !== "object" ||
      !("type" in item) ||
      item.type !== "text" ||
      !("text" in item) ||
      typeof item.text !== "string"
    ) {
      continue;
    }
    try {
      const parsed = JSON.parse(item.text) as {
        content?: { skill_content?: unknown };
        skill_content?: unknown;
      };
      const skillContent =
        parsed.content?.skill_content ?? parsed.skill_content;
      if (typeof skillContent === "string") return skillContent;
    } catch {
      if (item.text.trim()) return item.text;
    }
  }
  return null;
}

function managedToolError(content: unknown): string {
  if (!Array.isArray(content)) return "AWS skill retrieval failed";
  const text = content.flatMap((item) =>
    item &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string"
      ? [item.text]
      : []
  ).join("\n");
  return text || "AWS skill retrieval failed";
}

export async function loadAwsAlarmSkillContext(
  server: Pick<MCPServerStreamableHttp, "callTool">,
): Promise<AwsAlarmSkillContext> {
  const loaded = await Promise.all(
    AWS_ALARM_SKILL_NAMES.map(async (skillName) => {
      try {
        const result = await server.callTool(
          "aws___retrieve_skill",
          { skill_name: skillName },
        );
        if (result.isError) throw new Error(managedToolError(result));
        const content = managedSkillContent(result);
        if (!content) throw new Error("AWS skill returned no readable content");
        return { content: `## ${skillName}\n\n${content}`, skillName };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          skillName,
        };
      }
    }),
  );
  return {
    content: loaded
      .flatMap((result) => result.content ? [result.content] : [])
      .join("\n\n"),
    failures: loaded.flatMap((result) =>
      result.error ? [{ error: result.error, skillName: result.skillName }] : []
    ),
  };
}

export async function createAwsMcpServer(
  connection: RuntimeAwsConnection,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<MCPServerStreamableHttp> {
  const signedFetch = createAwsMcpFetch(
    createRefreshingAwsCredentialsProvider(connection, environment),
  );

  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: signedFetch,
    name: `aws-${connection.accountId}`,
    timeout: AWS_MCP_REQUEST_TIMEOUT_MS,
    toolFilter: awsReadOnlyToolFilter,
    url: AWS_MANAGED_MCP_ENDPOINT,
    useStructuredContent: true,
  });
}
