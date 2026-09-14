import { describe, expect, it } from "vitest";
import {
  codebaseKnowledgeContentSchema,
  redactCodebaseKnowledgeText,
  restrictedD2SourceSchema,
} from "./knowledge-base.js";

describe("codebase knowledge content", () => {
  it("accepts a complete set of Markdown guides and restricted D2 diagrams", () => {
    const content = codebaseKnowledgeContentSchema.parse({
      overview: "A source-grounded guide to the service.",
      documents: Array.from({ length: 10 }, (_, index) => ({
        slug: `guide-${index}`,
        title: `Guide ${index}`,
        summary: `Summary ${index}`,
        markdown: `# Guide ${index}\n\nVerified detail.`,
        sourcePaths: ["acme/service/src/index.ts"],
      })),
      diagrams: Array.from({ length: 10 }, (_, index) => ({
        slug: `diagram-${index}`,
        title: `Diagram ${index}`,
        summary: `Flow ${index}`,
        d2: "browser: Browser\napi: API\nbrowser -> api: HTTPS",
        sourcePaths: ["acme/service/src/index.ts"],
      })),
    });

    expect(content.documents).toHaveLength(10);
    expect(content.diagrams).toHaveLength(10);
  });

  it("rejects D2 outside the UI renderer's supported syntax", () => {
    expect(
      restrictedD2SourceSchema.safeParse(
        "browser: {\n  api: API\n}\nbrowser -> missing",
      ).success,
    ).toBe(false);
    expect(
      restrictedD2SourceSchema.safeParse(
        "browser: Browser\napi: API\nbrowser -> missing",
      ).success,
    ).toBe(false);
  });

  it("rejects duplicate source paths", () => {
    expect(
      codebaseKnowledgeContentSchema.safeParse({
        overview: "A source-grounded guide to the service.",
        documents: Array.from({ length: 8 }, (_, index) => ({
          slug: `guide-${index}`,
          title: `Guide ${index}`,
          summary: `Summary ${index}`,
          markdown: `# Guide ${index}`,
          sourcePaths: ["src/index.ts", "src/index.ts"],
        })),
        diagrams: Array.from({ length: 8 }, (_, index) => ({
          slug: `diagram-${index}`,
          title: `Diagram ${index}`,
          summary: `Summary ${index}`,
          d2: "browser: Browser\napi: API\nbrowser -> api",
          sourcePaths: [],
        })),
      }).success,
    ).toBe(false);
  });

  it("redacts common credentials before knowledge is persisted", () => {
    expect(
      redactCodebaseKnowledgeText(
        "Authorization: Bearer super-secret-token and token=github_pat_12345678901234567890",
      ),
    ).toBe("Authorization: Bearer [redacted] and token=[redacted]");
    expect(
      redactCodebaseKnowledgeText(
        "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----",
      ),
    ).toBe("[redacted]");
  });
});
