import { describe, expect, it } from "vitest";
import {
  memoryCredentialKinds,
  memoryInputSchema,
  renderMemoryIndex,
  renderMemoryMarkdown,
} from "./config.js";

describe("workspace memories", () => {
  it("writes a memory as a Claude Code memory file", () => {
    expect(renderMemoryMarkdown({
      body: "  On 2026-10-16 runs failed: the disk quota was full.\n",
      description: "Daytona's 2000 GiB disk limit: \"stopped\" sandboxes count",
      name: "daytona-disk-quota",
      type: "project",
    })).toBe([
      "---",
      "name: \"daytona-disk-quota\"",
      "description: \"Daytona's 2000 GiB disk limit: \\\"stopped\\\" sandboxes count\"",
      "metadata:",
      "  type: project",
      "---",
      "",
      "On 2026-10-16 runs failed: the disk quota was full.",
      "",
    ].join("\n"));
  });

  it("indexes memories one line each, as MEMORY.md does", () => {
    expect(renderMemoryIndex([
      { description: "Where the EU cell runs", name: "production-regions" },
      { description: "Restart the worker after RDS restarts", name: "worker-hangs" },
    ])).toBe(
      "- [production-regions](production-regions.md) — Where the EU cell runs\n- [worker-hangs](worker-hangs.md) — Restart the worker after RDS restarts\n",
    );
  });

  it("accepts Claude Code memory names and defaults the type to project", () => {
    expect(memoryInputSchema.parse({
      body: "Body",
      description: "One line",
      name: "verify-before-calling-something-unfixable",
    })).toEqual({
      body: "Body",
      description: "One line",
      name: "verify-before-calling-something-unfixable",
      type: "project",
    });
    expect(memoryInputSchema.safeParse({ body: "Body", description: "One line", name: "Has Spaces" }).success).toBe(false);
    for (const lineBreak of ["\n", "\r", "\u2028", "\u2029"]) {
      expect(memoryInputSchema.safeParse({ body: "Body", description: `Two${lineBreak}lines`, name: "two-lines" }).success).toBe(false);
    }
    expect(memoryInputSchema.safeParse({ body: "Body", description: "One line", name: "x", type: "secret" }).success).toBe(false);
  });

  it("finds values that look like credentials", () => {
    expect(memoryCredentialKinds({
      body: "Connect with postgres://responder:hunter2@db.internal:5432/app and AKIAABCDEFGHIJKLMNOP.",
      description: "Database access",
      name: "database-access",
    })).toEqual(["an AWS access key", "a URL with a password"]);
    expect(memoryCredentialKinds({
      body: `-----BEGIN OPENSSH PRIVATE KEY-----\nghp_${"a".repeat(36)}`,
      description: "Deploy key",
      name: "deploy-key",
    })).toEqual(["a private key", "a GitHub token"]);
    // The name is written into every run's index and file names.
    expect(memoryCredentialKinds({
      body: "Body",
      description: "Model access",
      name: `sk-proj-${"a1b2c3d4".repeat(5)}`,
    })).toEqual(["an API key"]);
    expect(memoryCredentialKinds({
      body: "The password is in Infisical under /prod/rds. Use the superlog-prod AWS profile. See https://docs.example.com/a:b.",
      description: "Where the RDS password is kept",
      name: "rds-password-location",
    })).toEqual([]);
  });
});
