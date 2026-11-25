import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { pullRequestApprovalRequired } from "@responder/core/db/pull-request-approval";
import { queueSuggestionPullRequests } from "@responder/core/db/suggestion-pull-requests";
import { createSuggestionTool } from "./suggestion-tools.js";

vi.mock("@responder/core/suggestions/model", () => ({
  suggestionSubmissionSchema: z.object({}).passthrough(),
}));
vi.mock("@responder/core/db/suggestions", () => ({
  createSuggestionIfMissing: vi.fn(async ({ suggestion }: { suggestion: Record<string, unknown> }) => ({
    created: true,
    suggestion: { ...suggestion, id: "suggestion-1" },
  })),
  getSuggestionSettings: vi.fn(async () => ({ autoOpenPullRequests: true })),
}));
vi.mock("@responder/core/db/suggestion-pull-requests", () => ({
  queueSuggestionPullRequests: vi.fn(async () => [{ id: "request-1" }]),
}));
vi.mock("@responder/core/db/pull-request-approval", () => ({
  pullRequestApprovalRequired: vi.fn(async () => false),
}));
vi.mock("./remediation-bases.js", () => ({
  attachRepositoryBasesToRemediations: vi.fn((remediations: unknown[]) => remediations),
}));
vi.mock("./suggestion-embeddings.js", () => ({
  embedSuggestion: vi.fn(async () => [0]),
  searchCanonicalSuggestions: vi.fn(),
}));

const submission = {
  codeChange: { changes: [], description: "Add a span.", title: "Add a span", type: "code_change" },
  detail: "Add a span around the checkout call.",
  subtitle: "Checkout calls have no span.",
  title: "Trace checkout calls",
};

function suggestionTool() {
  return createSuggestionTool({
    agentConfigVersionId: "08080808-0808-4808-8808-080808080808",
    investigationId: "16161616-1616-4616-8616-161616161616",
    organizationId: "15151515-1515-4515-8515-151515151515",
    repositories: [],
  });
}

describe("automatic suggestion pull requests", () => {
  afterEach(() => vi.clearAllMocks());

  it("queues the pull request when the workspace opens them automatically", async () => {
    await expect(suggestionTool().invoke(undefined as never, JSON.stringify(submission)))
      .resolves.toMatchObject({ automaticPullRequestRequestIds: ["request-1"] });
    expect(queueSuggestionPullRequests).toHaveBeenCalled();
  });

  it("leaves it to a person when the workspace asks before pull requests", async () => {
    vi.mocked(pullRequestApprovalRequired).mockResolvedValueOnce(true);
    await expect(suggestionTool().invoke(undefined as never, JSON.stringify(submission)))
      .resolves.toMatchObject({ automaticPullRequestRequestIds: [] });
    expect(pullRequestApprovalRequired).toHaveBeenCalledWith("15151515-1515-4515-8515-151515151515");
    expect(queueSuggestionPullRequests).not.toHaveBeenCalled();
  });
});
