import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeWorkspaceMemories } from "./workspace-memories.js";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const memories = Array.from({ length: 150 }, (_, index) => ({
  body: `Fact ${index}.`,
  description: `Memory ${index}`,
  name: `memory-${index}`,
  type: "project" as const,
}));

function session(...outputs: string[]) {
  const execCommand = vi.fn();
  for (const output of outputs) execCommand.mockResolvedValueOnce(output);
  return {
    execCommand,
    materializeEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaytonaSandboxSession & {
    execCommand: ReturnType<typeof vi.fn>;
    materializeEntry: ReturnType<typeof vi.fn>;
  };
}

describe("materializeWorkspaceMemories", () => {
  it("writes every memory in one archive after `.responder` resolves to itself", async () => {
    const sandbox = session("Process exited with code 0", "Process exited with code 0");

    await materializeWorkspaceMemories(sandbox, memories);

    const prepare: string = sandbox.execCommand.mock.calls[0]![0].cmd;
    const guard = prepare.indexOf("[ \"$(realpath -e -- '/home/daytona/workspace/.responder')\" = '/home/daytona/workspace/.responder' ]");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(prepare.indexOf("rm -rf -- '/home/daytona/workspace/.responder/memory'"));
    expect(sandbox.materializeEntry).toHaveBeenCalledTimes(1);
    expect(sandbox.materializeEntry.mock.calls[0]![0].path).toBe("/home/daytona/workspace/.responder/memory.tar");
    const extract: string = sandbox.execCommand.mock.calls[1]![0].cmd;
    expect(extract).toContain("tar -xf '/home/daytona/workspace/.responder/memory.tar'");
    expect(extract).toContain("-C '/home/daytona/workspace/.responder/memory'");
    expect(extract).toContain("rm -f -- '/home/daytona/workspace/.responder/memory.tar'");
    expect(sandbox.execCommand).toHaveBeenCalledTimes(2);
  });

  it("writes the index and one file per memory", async () => {
    const sandbox = session("Process exited with code 0", "Process exited with code 0");
    await materializeWorkspaceMemories(sandbox, memories.slice(0, 2));

    const directory = await mkdtemp(join(tmpdir(), "workspace-memories-"));
    directories.push(directory);
    await writeFile(join(directory, "memory.tar"), sandbox.materializeEntry.mock.calls[0]![0].entry.content);
    await run("tar", ["-xf", join(directory, "memory.tar"), "-C", directory]);

    expect((await readdir(directory)).sort()).toEqual(["MEMORY.md", "memory-0.md", "memory-1.md", "memory.tar"]);
    expect(await readFile(join(directory, "MEMORY.md"), "utf8")).toBe(
      "- [memory-0](memory-0.md) — Memory 0\n- [memory-1](memory-1.md) — Memory 1\n",
    );
    expect(await readFile(join(directory, "memory-1.md"), "utf8")).toContain("Fact 1.");
  });

  it("only empties the folder when there are no memories", async () => {
    const sandbox = session("Process exited with code 0");

    await materializeWorkspaceMemories(sandbox, []);

    expect(sandbox.execCommand).toHaveBeenCalledTimes(1);
    expect(sandbox.execCommand.mock.calls[0]![0].cmd).not.toContain("mkdir -- ");
    expect(sandbox.materializeEntry).not.toHaveBeenCalled();
  });

  it("writes nothing when the folder cannot be prepared, such as through a symlink", async () => {
    const sandbox = session("Process exited with code 1");

    await expect(materializeWorkspaceMemories(sandbox, memories)).rejects.toThrow(
      "Unable to prepare the sandbox memory folder",
    );
    expect(sandbox.materializeEntry).not.toHaveBeenCalled();
  });

  it("fails when the archive does not extract", async () => {
    const sandbox = session("Process exited with code 0", "tar: Error\nProcess exited with code 2");

    await expect(materializeWorkspaceMemories(sandbox, memories)).rejects.toThrow(
      "Unable to write the sandbox memories",
    );
  });
});
