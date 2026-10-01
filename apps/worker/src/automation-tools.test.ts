import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  automationToolDefinitions,
  automationToolServerSource,
  installAutomationToolServer,
  serveAutomationTools,
} from "./automation-tools.js";

const requestId = "11111111-2222-4333-8444-555555555555";

describe("automation tool bridge", () => {
  it("installs the sandbox server and clears requests from an earlier turn", async () => {
    const session = { materializeEntry: vi.fn().mockResolvedValue(undefined) };

    await installAutomationToolServer(session);

    expect(session.materializeEntry).toHaveBeenCalledWith({
      entry: { type: "file", content: expect.stringContaining("tools/list") },
      path: "/home/daytona/workspace/.responder/tools/server.mjs",
    });
    expect(session.materializeEntry).toHaveBeenCalledWith({
      entry: { type: "file", content: "" },
      path: "/home/daytona/workspace/.responder/tools/requests.jsonl",
    });
  });

  it("answers each complete request once and waits for a partial line", async () => {
    let requests = `${JSON.stringify({ arguments: { title: "Fix" }, id: requestId, name: "open_pull_request" })}\n{"arguments":`;
    const session = {
      materializeEntry: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(async () => new TextEncoder().encode(requests)),
    };
    const handle = vi.fn().mockResolvedValue({
      content: [{ text: "{\"url\":\"https://github.com/acme/app/pull/1\"}", type: "text" }],
    });
    const onError = vi.fn();

    const tools = serveAutomationTools({ handle, intervalMs: 1, onError, session });
    await vi.waitFor(() => expect(session.materializeEntry).toHaveBeenCalledOnce());
    requests += "{}}\n";
    const reads = session.readFile.mock.calls.length;
    await vi.waitFor(() => expect(session.readFile.mock.calls.length).toBeGreaterThan(reads + 2));
    await tools.stop();

    expect(handle).toHaveBeenCalledOnce();
    expect(handle).toHaveBeenCalledWith({ arguments: { title: "Fix" }, name: "open_pull_request" });
    expect(session.materializeEntry).toHaveBeenCalledWith({
      entry: {
        type: "file",
        content: JSON.stringify({
          content: [{ text: "{\"url\":\"https://github.com/acme/app/pull/1\"}", type: "text" }],
        }),
      },
      path: `/home/daytona/workspace/.responder/tools/responses/${requestId}.json`,
    });
    // The completed second line has no valid ID.
    expect(onError).toHaveBeenCalledOnce();
  });

  it("answers with a tool error when the handler throws", async () => {
    const session = {
      materializeEntry: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(async () => new TextEncoder().encode(
        `${JSON.stringify({ arguments: {}, id: requestId, name: "open_pull_request" })}\n`,
      )),
    };
    const onError = vi.fn();

    const tools = serveAutomationTools({
      handle: vi.fn().mockRejectedValue(new Error("database unavailable")),
      intervalMs: 1,
      onError,
      session,
    });
    await vi.waitFor(() => expect(session.materializeEntry).toHaveBeenCalledOnce());
    await tools.stop();

    expect(JSON.parse(session.materializeEntry.mock.calls[0]![0].entry.content)).toEqual({
      content: [{ text: "The tool failed unexpectedly.", type: "text" }],
      isError: true,
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "database unavailable" }));
  });
});

describe("tool definitions", () => {
  it("offers post_notification only to a run with notification channels", () => {
    expect(automationToolDefinitions().map((tool) => tool.name)).not.toContain("post_notification");
    expect(automationToolDefinitions().map((tool) => tool.name)).not.toContain("skip_notification");
    expect(automationToolDefinitions(["#ops"]).map((tool) => tool.name)).toContain("skip_notification");
    const notify = automationToolDefinitions(["#ops"]).find((tool) => tool.name === "post_notification");
    expect(notify?.description).toContain("(#ops)");
    expect(notify?.inputSchema.properties).toHaveProperty("details");
  });
});

describe("sandbox tool server", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  async function startServer(waitMs: number) {
    directory = await mkdtemp(join(tmpdir(), "responder-tools-"));
    const serverPath = join(directory, "server.mjs");
    await writeFile(serverPath, automationToolServerSource(directory, waitMs));
    const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
    const replies = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const request = async (message: Record<string, unknown>) => {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      return JSON.parse((await replies.next()).value as string) as Record<string, unknown>;
    };
    return { child, directory, request };
  }

  it("speaks MCP over stdio and relays a call through the request and response files", async () => {
    const { child, directory: root, request } = await startServer(10_000);
    try {
      await expect(request({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }))
        .resolves.toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18" } });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const listed = await request({ id: 2, method: "tools/list" }) as { result: { tools: Array<{ name: string }> } };
      expect(listed.result.tools.map((tool) => tool.name)).toEqual([
        "open_pull_request",
        "github_api",
        "fetch_ref",
      ]);

      const answer = { content: [{ text: "{\"url\":\"https://github.com/acme/app/pull/1\"}", type: "text" }] };
      const reply = request({
        id: 3,
        method: "tools/call",
        params: { arguments: { repository: "acme/app" }, name: "open_pull_request" },
      });
      // Play the worker: read the request and write its response.
      let line = "";
      await vi.waitFor(async () => {
        line = (await readFile(join(root, "requests.jsonl"), "utf8").catch(() => "")).trim();
        expect(line).not.toBe("");
      });
      const forwarded = JSON.parse(line) as { arguments: unknown; id: string; name: string };
      expect(forwarded).toMatchObject({ arguments: { repository: "acme/app" }, name: "open_pull_request" });
      await writeFile(join(root, "responses", `${forwarded.id}.json`), JSON.stringify(answer));

      await expect(reply).resolves.toEqual({ id: 3, jsonrpc: "2.0", result: answer });
    } finally {
      child.kill();
    }
  });

  it("asks the agent to call again when the worker has not answered in time", async () => {
    const { child, request } = await startServer(50);
    try {
      await expect(request({
        id: 1,
        method: "tools/call",
        params: { arguments: {}, name: "open_pull_request" },
      })).resolves.toMatchObject({
        result: {
          content: [{ text: expect.stringContaining("Call the tool again"), type: "text" }],
          isError: true,
        },
      });
    } finally {
      child.kill();
    }
  });
});
