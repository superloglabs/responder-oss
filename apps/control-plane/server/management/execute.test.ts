import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createConcurrencyLimiter, WorkspaceBusyError } from "../workspace-limits.js";
import { executeOperation } from "./execute.js";
import { defineOperation, type ManagementContext } from "./operation.js";

vi.mock("@sentry/hono/node", () => ({ captureException: vi.fn(), setTag: vi.fn(), setUser: vi.fn() }));

const caller = (organizationId: string): ManagementContext => ({
  apiKeyId: "key", clientName: "Key", oauthClientId: null, organizationId, role: "member", source: "api",
  user: { email: "person@example.com", id: "22222222-2222-4222-8222-222222222222", name: "Person" },
});

function operation(run: () => Promise<{ ok: boolean }>) {
  return defineOperation({
    description: "Test", effect: "read", input: z.object({}), method: "GET", name: "test_operation",
    output: z.object({ ok: z.boolean() }), path: "/test", run, summary: "Test", tag: "Workspace" as never,
  });
}

describe("executeOperation per-workspace limit", () => {
  it("answers 429 when a workspace has too many operations running", async () => {
    let finish!: () => void;
    const slow = operation(() => new Promise((resolve) => { finish = () => resolve({ ok: true }); }));
    const limiter = createConcurrencyLimiter({ limit: 1, maxWaiting: 0, waitMs: 0 });

    const first = executeOperation(slow, caller("org-a"), {}, limiter);
    const refused = await executeOperation(slow, caller("org-a"), {}, limiter);
    const other = executeOperation(operation(async () => ({ ok: true })), caller("org-b"), {}, limiter);

    expect(refused).toMatchObject({ body: { code: "workspace_busy" }, headers: { "retry-after": "1" }, status: 429 });
    expect((await other).status).toBe(200);
    finish();
    expect((await first).status).toBe(200);
  });

  it("turns a busy error from inside the operation into 429 with a retry hint", async () => {
    const busy = operation(async () => { throw new WorkspaceBusyError(20); });

    expect(await executeOperation(busy, caller("org-a"), {})).toMatchObject({
      body: { code: "workspace_busy", retryAfterSeconds: 20 },
      headers: { "retry-after": "20" },
      status: 429,
    });
  });
});
