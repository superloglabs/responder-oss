import { describe, expect, it } from "vitest";
import {
  parseSkillMarkdown,
  renderSkillMarkdown,
  skillInputSchema,
} from "./config.js";

const baseSkill = {
  name: "billing-api",
  description: "Look up customer invoices in the billing API.",
  instructions: "Call GET /v1/invoices with the BILLING_API_KEY bearer token.",
};

describe("skill input", () => {
  it("accepts a skill with reference files and secrets", () => {
    const secretId = "31313131-3131-4131-8131-313131313131";
    expect(skillInputSchema.parse({
      ...baseSkill,
      files: [{ path: "reference/openapi.yaml", content: "openapi: 3.1.0\n" }],
      secretIds: [secretId],
    })).toEqual({
      ...baseSkill,
      files: [{ path: "reference/openapi.yaml", content: "openapi: 3.1.0\n" }],
      secretIds: [secretId],
    });
  });

  it("rejects names that are not lowercase hyphenated words", () => {
    for (const name of ["Billing", "billing api", "billing--api", "-billing", "a".repeat(65)]) {
      expect(skillInputSchema.safeParse({ ...baseSkill, name }).success).toBe(false);
    }
  });

  it("rejects paths that leave the folder, hide a file, or replace SKILL.md", () => {
    for (const path of ["../secrets", "/etc/passwd", "reference/../x", ".env", "docs/.hidden", "skill.md", "SKILL.md/notes.md", "a//b", "docs/"]) {
      expect(
        skillInputSchema.safeParse({ ...baseSkill, files: [{ path, content: "x" }] }).success,
        path,
      ).toBe(false);
    }
  });

  it("rejects duplicate paths and a path that is also a folder", () => {
    expect(skillInputSchema.safeParse({
      ...baseSkill,
      files: [{ path: "a.md", content: "" }, { path: "A.md", content: "" }],
    }).success).toBe(false);
    expect(skillInputSchema.safeParse({
      ...baseSkill,
      files: [{ path: "docs", content: "" }, { path: "docs/a.md", content: "" }],
    }).success).toBe(false);
  });

  it("rejects binary files and files over the size limit", () => {
    expect(skillInputSchema.safeParse({
      ...baseSkill,
      files: [{ path: "logo.png", content: "\u0000PNG" }],
    }).success).toBe(false);
    expect(skillInputSchema.safeParse({
      ...baseSkill,
      files: [{ path: "spec.json", content: "x".repeat(3 * 1024 * 1024 + 1) }],
    }).success).toBe(false);
  });

  it("measures files as they are sent, so escaping cannot push a request over its limit", () => {
    // Each quote is escaped, so 2 MiB of quotes is 4 MiB in the request.
    expect(skillInputSchema.safeParse({
      ...baseSkill,
      files: [{ path: "quotes.txt", content: "\"".repeat(2 * 1024 * 1024) }],
    }).success).toBe(false);
  });
});

describe("SKILL.md", () => {
  it("renders front matter that survives YAML special characters", () => {
    const markdown = renderSkillMarkdown({
      ...baseSkill,
      description: "Billing: invoices # and \"refunds\"",
    });
    expect(markdown).toBe([
      "---",
      "name: \"billing-api\"",
      "description: \"Billing: invoices # and \\\"refunds\\\"\"",
      "---",
      "",
      baseSkill.instructions,
      "",
    ].join("\n"));
    expect(parseSkillMarkdown(markdown)).toEqual({
      ...baseSkill,
      description: "Billing: invoices # and \"refunds\"",
    });
  });

  it("reads plain, quoted, and block scalar front matter", () => {
    expect(parseSkillMarkdown([
      "---",
      "name: billing-api",
      "description: >",
      "  Look up invoices",
      "  and refunds.",
      "license: 'Apache-2.0' # SPDX",
      "compatibility: claude-code # and codex",
      "---",
      "# Billing",
      "",
      "Use the API.",
    ].join("\r\n"))).toEqual({
      name: "billing-api",
      description: "Look up invoices and refunds.",
      instructions: "# Billing\n\nUse the API.",
    });
  });

  it("drops trailing comments from plain values", () => {
    expect(parseSkillMarkdown("---\nname: billing-api # API skill\ndescription: \"Billing # invoices\" # quoted\n---\nUse it.")).toEqual({
      name: "billing-api",
      description: "Billing # invoices",
      instructions: "Use it.",
    });
  });

  it("keeps a quoted value whole when other text follows the closing quote", () => {
    expect(parseSkillMarkdown("---\nname: \"billing\" typo\n---\nUse it.").name).toBe("\"billing\" typo");
  });

  it("treats a file without front matter as instructions", () => {
    expect(parseSkillMarkdown("# Billing\nUse the API.\n")).toEqual({
      instructions: "# Billing\nUse the API.",
    });
  });
});
