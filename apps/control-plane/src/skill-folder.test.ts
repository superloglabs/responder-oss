import { describe, expect, it } from "vitest";
import { folderRelativePath, formatFileSize, mergeSkillFiles, readSkillFolder } from "./skill-folder";

const text = (value: string) => new TextEncoder().encode(value);

describe("readSkillFolder", () => {
  it("reads SKILL.md and keeps the other text files", () => {
    expect(readSkillFolder([
      { path: "SKILL.md", bytes: text("---\nname: billing-api\ndescription: Look up invoices.\n---\nUse the API.") },
      { path: "reference/openapi.yaml", bytes: text("openapi: 3.1.0\n") },
      { path: "examples.md", bytes: text("# Examples\n") },
    ])).toEqual({
      skill: { name: "billing-api", description: "Look up invoices.", instructions: "Use the API." },
      files: [
        { path: "examples.md", content: "# Examples\n" },
        { path: "reference/openapi.yaml", content: "openapi: 3.1.0\n" },
      ],
      skipped: [],
    });
  });

  it("skips hidden files quietly and reports binary files and unsupported names", () => {
    expect(readSkillFolder([
      { path: ".DS_Store", bytes: new Uint8Array([0, 1, 2]) },
      { path: "scripts/.env", bytes: text("TOKEN=x") },
      { path: "logo.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff]) },
      { path: "my notes.md", bytes: text("notes") },
    ])).toEqual({
      files: [],
      skipped: [
        { path: "logo.png", reason: "not a text file" },
        { path: "my notes.md", reason: "unsupported file name" },
      ],
    });
  });
});

describe("folderRelativePath", () => {
  it("drops the uploaded folder's own name", () => {
    expect(folderRelativePath("billing-api/reference/openapi.yaml")).toBe("reference/openapi.yaml");
    expect(folderRelativePath("billing-api/SKILL.md")).toBe("SKILL.md");
  });
});

describe("mergeSkillFiles", () => {
  it("replaces a file with the same path and keeps the rest", () => {
    expect(mergeSkillFiles(
      [{ path: "openapi.yaml", content: "old" }, { path: "notes.md", content: "keep" }],
      [{ path: "openapi.yaml", content: "new" }],
    )).toEqual([
      { path: "notes.md", content: "keep" },
      { path: "openapi.yaml", content: "new" },
    ]);
  });
});

describe("formatFileSize", () => {
  it("uses bytes, kilobytes, and megabytes", () => {
    expect(formatFileSize("abc")).toBe("3 B");
    expect(formatFileSize("x".repeat(2048))).toBe("2.0 KB");
    expect(formatFileSize("x".repeat(3 * 1024 * 1024))).toBe("3.0 MB");
  });
});
