import path from "node:path";
import type { SandboxSession } from "./sandbox-session.js";
import type { RuntimeWorkspaceMemory } from "@responder/core/db/workspace-memories";
import { renderInvestigationPromptPart, type InvestigationPromptParts } from "@responder/core/investigations/prompt-parts";
import {
  memoryFileName,
  memoryIndexFileName,
  renderMemoryIndex,
  renderMemoryMarkdown,
} from "@responder/core/memories/config";
import { automationWorkspaceRoot } from "./automation-harness.js";

// The workspace's memories, one file each and a MEMORY.md index, as Claude
// Code keeps them. Automation runs and investigations share the folder.
export const workspaceMemoryRoot = `${automationWorkspaceRoot}/.responder/memory`;

// Writes the memories. The folder is emptied first: a sandbox can hold the
// memories of an earlier turn, and edits and deletions since then must
// apply, as must anything the agent changed there. The agent controls the
// sandbox between turns, so `.responder` must resolve to itself before
// anything under it is removed.
export async function materializeWorkspaceMemories(
  session: SandboxSession,
  memories: RuntimeWorkspaceMemory[],
): Promise<void> {
  const parent = path.posix.dirname(workspaceMemoryRoot);
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      `mkdir -p -- '${parent}'`,
      `[ "$(realpath -e -- '${parent}')" = '${parent}' ]`,
      `rm -rf -- '${workspaceMemoryRoot}'`,
      ...(memories.length > 0 ? [`mkdir -- '${workspaceMemoryRoot}'`] : []),
    ].join("\n"),
    maxOutputTokens: 200,
    workdir: automationWorkspaceRoot,
  });
  if (!/(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output)) {
    throw new Error("Unable to prepare the sandbox memory folder");
  }
  if (memories.length === 0) return;
  await session.materializeEntry({
    entry: { type: "file", content: renderMemoryIndex(memories) },
    path: `${workspaceMemoryRoot}/${memoryIndexFileName}`,
  });
  for (const memory of memories) {
    await session.materializeEntry({
      entry: { type: "file", content: renderMemoryMarkdown(memory) },
      path: `${workspaceMemoryRoot}/${memoryFileName(memory)}`,
    });
  }
}

// Lists every memory so the agent can choose which to read.
export function workspaceMemoryInstructions(
  memories: RuntimeWorkspaceMemory[],
  promptParts?: InvestigationPromptParts,
): string | null {
  if (memories.length === 0) return null;
  const prompt = (key: string, values: Record<string, string> = {}) =>
    renderInvestigationPromptPart(key, promptParts, values);
  return [
    prompt("memoryHeader", { path: workspaceMemoryRoot }),
    ...memories.map((memory) => prompt("memoryEntry", {
      description: memory.description,
      file: memoryFileName(memory),
      name: memory.name,
    })),
    prompt("memoryUsage"),
  ].join("\n");
}
