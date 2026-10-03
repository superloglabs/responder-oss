import { describe, expect, it } from "vitest";
import { mcpClientSetups, mcpServerUrl } from "./mcp-connection-snippets";

describe("MCP connection snippets", () => {
  const url = mcpServerUrl("https://superlog.sh");

  it("points every client at the MCP server without an API key", () => {
    expect(url).toBe("https://superlog.sh/api/mcp");
    const setups = mcpClientSetups(url);

    expect(setups.map((setup) => setup.label)).toEqual([
      "Claude Code",
      "Claude",
      "Cursor",
      "VS Code",
      "Codex",
    ]);
    for (const setup of setups) {
      expect(setup.snippet).toContain(url);
      expect(setup.snippet).not.toMatch(/Authorization|Bearer|slk_/u);
    }
  });

  it("gives each client the command or file it reads", () => {
    const setups = Object.fromEntries(
      mcpClientSetups(url).map((setup) => [setup.value, setup.snippet]),
    );

    expect(setups["claude-code"]).toBe(
      "claude mcp add --transport http superlog https://superlog.sh/api/mcp",
    );
    expect(JSON.parse(setups.cursor ?? "")).toEqual({
      mcpServers: { superlog: { url } },
    });
    expect(JSON.parse(setups.vscode ?? "")).toEqual({
      servers: { superlog: { type: "http", url } },
    });
    expect(setups.codex).toBe("codex mcp add superlog --url https://superlog.sh/api/mcp");
  });
});
