// Setup instructions for MCP clients that sign in with OAuth. Each client
// opens Superlog in the browser the first time it connects.

export type McpClientId = "claude-code" | "claude" | "cursor" | "vscode" | "codex";

export interface McpClientSetup {
  // Shown above the snippet.
  instructions: string;
  label: string;
  language: string;
  // Shown below the snippet: how to start the sign-in.
  signIn: string;
  snippet: string;
  value: McpClientId;
}

export function mcpServerUrl(origin: string): string {
  return new URL("/api/mcp", origin).toString();
}

export function mcpClientSetups(serverUrl: string): McpClientSetup[] {
  return [
    {
      instructions: "Run this in a terminal:",
      label: "Claude Code",
      language: "bash",
      signIn: "Then run /mcp in Claude Code, choose superlog, and sign in.",
      snippet: `claude mcp add --transport http superlog ${serverUrl}`,
      value: "claude-code",
    },
    {
      instructions:
        "In Claude on the web or desktop, open Settings → Connectors, choose Add custom connector, and enter:",
      label: "Claude",
      language: "text",
      signIn: "Then choose Connect and sign in.",
      snippet: `Name: Superlog\nURL:  ${serverUrl}`,
      value: "claude",
    },
    {
      instructions: "Add the server to ~/.cursor/mcp.json, or to .cursor/mcp.json in a project:",
      label: "Cursor",
      language: "json",
      signIn: "Then open Cursor Settings → MCP and choose Connect next to superlog.",
      snippet: JSON.stringify({ mcpServers: { superlog: { url: serverUrl } } }, null, 2),
      value: "cursor",
    },
    {
      instructions: "Add the server to .vscode/mcp.json:",
      label: "VS Code",
      language: "json",
      signIn: "Then start the server from the file and allow VS Code to sign in.",
      snippet: JSON.stringify(
        { servers: { superlog: { type: "http", url: serverUrl } } },
        null,
        2,
      ),
      value: "vscode",
    },
    {
      instructions: "Run this in a terminal:",
      label: "Codex",
      language: "bash",
      signIn: "Codex opens the browser to sign in. To sign in again later, run codex mcp login superlog.",
      snippet: `codex mcp add superlog --url ${serverUrl}`,
      value: "codex",
    },
  ];
}
