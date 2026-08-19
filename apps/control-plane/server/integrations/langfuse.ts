import { z } from "zod";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import {
  langfuseBasicAuthorization,
  langfuseProjectsUrl,
  LangfuseMcpUnavailableError,
  normalizeLangfuseBaseUrl,
  verifyLangfuseMcpConnection,
} from "@responder/core/integrations/langfuse";

const langfuseProjectsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().trim().min(1),
      organization: z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1),
      }),
    }),
  ).min(1),
});

export class LangfuseCredentialsError extends Error {
  constructor() {
    super("Langfuse rejected the project public key or secret key");
  }
}

export async function langfuseProject(
  input: {
    baseUrl: string;
    publicKey: string;
    secretKey: string;
  },
  options: {
    fetch?: typeof fetch;
    verifyMcp?: typeof verifyLangfuseMcpConnection;
  } = {},
) {
  const baseUrl = normalizeLangfuseBaseUrl(input.baseUrl);
  const fetchFn = options.fetch ?? safeCustomMcpFetch;
  const response = await fetchFn(langfuseProjectsUrl(baseUrl), {
    headers: {
      accept: "application/json",
      authorization: langfuseBasicAuthorization(input),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new LangfuseCredentialsError();
  }
  if (!response.ok) throw new Error("Unable to load the Langfuse project");

  const project = langfuseProjectsSchema.parse(await response.json()).data[0]!;
  try {
    await (options.verifyMcp ?? verifyLangfuseMcpConnection)({
      baseUrl,
      publicKey: input.publicKey,
      secretKey: input.secretKey,
    });
  } catch (error) {
    if (error instanceof LangfuseMcpUnavailableError) {
      throw error;
    }
    throw new Error("Unable to verify the Langfuse MCP endpoint");
  }
  return {
    baseUrl,
    displayName: `${project.organization.name} / ${project.name}`,
    externalAccountId: `${baseUrl}:${project.id}`,
    metadata: {
      baseUrl,
      organizationId: project.organization.id,
      organizationName: project.organization.name,
      projectId: project.id,
      projectName: project.name,
    },
    projectId: project.id,
  };
}
