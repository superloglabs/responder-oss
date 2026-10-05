import { describe, expect, it } from "vitest";
import { folderRelativePath, formatFileSize, likelyCredentialSources, mergeSkillFiles, readSkillFolder } from "./skill-folder";

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
    )).toEqual({
      files: [
        { path: "notes.md", content: "keep" },
        { path: "openapi.yaml", content: "new" },
      ],
      skipped: [],
    });
  });

  it("leaves out files past the count and size limits so the skill stays savable", () => {
    const current = Array.from({ length: 99 }, (_, index) => ({ path: `file-${index}.md`, content: "x" }));
    expect(mergeSkillFiles(current, [
      { path: "file-0.md", content: "replaced" },
      { path: "one-more.md", content: "x" },
      { path: "two-more.md", content: "x" },
    ]).skipped).toEqual([{ path: "two-more.md", reason: "over the 100-file limit" }]);

    const big = "x".repeat(2 * 1024 * 1024);
    const merged = mergeSkillFiles([{ path: "spec.json", content: big }], [
      { path: "other.json", content: big },
      { path: "small.md", content: "x" },
    ]);
    expect(merged.files.map((file) => file.path)).toEqual(["small.md", "spec.json"]);
    expect(merged.skipped).toEqual([{ path: "other.json", reason: "over the 3 MB limit" }]);
  });
});

describe("likelyCredentialSources", () => {
  it("names texts that hold common credential formats", () => {
    expect(likelyCredentialSources([
      { name: "SKILL.md", content: "curl -H \"Authorization: Bearer $BILLING_API_KEY\" https://api.example" },
      { name: "keys.md", content: "aws_access_key_id = AKIAABCDEFGHIJKLMNOP" },
      { name: "notes.md", content: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" },
      { name: "key.pem", content: "-----BEGIN RSA PRIVATE KEY-----\nMIIE" },
    ])).toEqual(["keys.md", "notes.md", "key.pem"]);
  });
});

describe("formatFileSize", () => {
  it("uses bytes, kilobytes, and megabytes", () => {
    expect(formatFileSize("abc")).toBe("3 B");
    expect(formatFileSize("x".repeat(2048))).toBe("2.0 KB");
    expect(formatFileSize("x".repeat(3 * 1024 * 1024))).toBe("3.0 MB");
  });
});
