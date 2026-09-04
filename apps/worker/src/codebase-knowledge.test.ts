import { describe, expect, it } from "vitest";
import {
  codebaseKnowledgeInstructions,
  repositoryRevisionsMatch,
} from "./codebase-knowledge.js";

const revision = {
  branch: "main",
  repository: "acme/service",
  sha: "a".repeat(40),
};

describe("codebase knowledge refresh", () => {
  it("compares repository revisions without depending on row order", () => {
    const second = {
      branch: "trunk",
      repository: "acme/web",
      sha: "b".repeat(40),
    };
    expect(repositoryRevisionsMatch([revision, second], [second, revision])).toBe(true);
    expect(repositoryRevisionsMatch([revision], [{ ...revision, sha: "c".repeat(40) }])).toBe(false);
  });

  it("requires roughly ten documents and restricted D2 sources", () => {
    const instructions = codebaseKnowledgeInstructions(revision);
    expect(instructions).toContain("8–12 complementary Markdown documents");
    expect(instructions).toContain("8–12 complementary D2 diagrams");
    expect(instructions).toContain("source_id -> target_id");
    expect(instructions).toContain(revision.sha);
  });
});
