import { memoryImportMaxCount } from "../../../packages/core/src/memories/config";

// How a person brings memories from Claude Code or Codex into the workspace:
// connect their agent to the Superlog MCP server, then give it a prompt that
// reads its own memories and imports the ones the team should share.

export type MemoryImportClient = "claude-code" | "codex";

export interface MemoryImportSetup {
  label: string;
  // Shown below the command.
  signIn: string;
  snippet: string;
  value: MemoryImportClient;
}

// User scope, so every Claude Code session can import, including ones that
// Conductor starts in its own workspace folders.
export function memoryImportSetups(serverUrl: string): MemoryImportSetup[] {
  return [
    {
      label: "Claude Code",
      signIn: "Then run /mcp in Claude Code, choose superlog, and sign in.",
      snippet: `claude mcp add --scope user --transport http superlog ${serverUrl}`,
      value: "claude-code",
    },
    {
      label: "Codex",
      signIn: "Codex opens the browser to sign in. To sign in again later, run codex mcp login superlog.",
      snippet: `codex mcp add superlog --url ${serverUrl}`,
      value: "codex",
    },
  ];
}

export const memoryImportPrompt = [
  "Import what you remember about this project into Superlog as workspace memories, using the Superlog MCP tools.",
  "",
  "1. Collect your memories for this project. In Claude Code, they are the files in your auto-memory directory for this project under ~/.claude/projects/: MEMORY.md and the files it links to. In Codex, they are the files in ~/.codex/memories/. Leave out CLAUDE.md and AGENTS.md files in the repository: Superlog reads those from the repository.",
  "2. Keep the memories that would help an agent investigate production problems or work on this code: how the systems are set up and where they run, past incidents and their causes, runbooks, and team conventions. Leave out personal preferences, such as how I like replies written, and anything that was true only for one conversation.",
  "3. Superlog shares memories with the whole workspace, and every automation run and tag mode thread reads them. Remove credentials, tokens, passwords, and connection strings, and say where each secret is kept instead. Remove personal data about customers.",
  `4. Call list_memories. Then call import_memories with up to ${memoryImportMaxCount} memories per call. Keep each memory's name, description, and type from its front matter, and its body. Give a memory without front matter a short kebab-case name and a one-line description. Keep [[name]] links between memories.`,
  "5. If a memory with the same name already exists, compare the two. Show me the differences and ask before calling update_memory.",
  "6. Tell me which memories you imported, which you left out and why, and share the link import_memories returns.",
].join("\n");
