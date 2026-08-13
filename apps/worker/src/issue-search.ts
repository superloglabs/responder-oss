import { tool } from "@openai/agents";
import { z } from "zod";
import { searchCanonicalIssues } from "./issue-embeddings.js";

export function createSearchExistingIssuesTool(input: {
  organizationId: string;
  environment?: NodeJS.ProcessEnv;
}) {
  return tool({
    name: "search_existing_issues",
    description:
      "Search this organization's existing issues for possible matches before creating a duplicate issue.",
    parameters: z.object({
      query: z.string().trim().min(1).max(4_000),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    async execute(query) {
      return searchCanonicalIssues(
        {
          organizationId: input.organizationId,
          query: query.query,
          limit: query.limit,
        },
        input.environment,
      );
    },
  });
}
