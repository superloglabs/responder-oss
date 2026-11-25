import { describe, expect, it } from "vitest";
import { agentRows, moveAgent } from "./coding-agents-model";
import { settingsBody, withSettingsDefaults } from "./model";

describe("coding agent settings", () => {
  it("lists the agents turned on in their order, then the rest", () => {
    expect(agentRows({ agents: ["capy", "claude"], claudeSurface: "terminal" })).toEqual([
      { agent: "capy", on: true },
      { agent: "claude", on: true },
      { agent: "codex", on: false },
      { agent: "conductor", on: false },
      { agent: "cmux", on: false },
      { agent: "replicas", on: false },
    ]);
  });

  it("moves an agent among the ones turned on and ignores moves past the ends", () => {
    expect(moveAgent(["claude", "codex", "capy"], 2, 0)).toEqual(["capy", "claude", "codex"]);
    expect(moveAgent(["claude", "codex"], 0, 1)).toEqual(["codex", "claude"]);
    expect(moveAgent(["claude", "codex"], 0, -1)).toEqual(["claude", "codex"]);
    expect(moveAgent(["claude", "codex"], 1, 2)).toEqual(["claude", "codex"]);
  });

  it("shows Claude Code and Codex for servers that do not send the agents, and saves them", () => {
    const settings = withSettingsDefaults({ enabled: true, slack: null, repositoryIds: [] });
    expect(settings.codingAgents).toEqual({ agents: ["claude", "codex"], claudeSurface: "terminal" });
    expect(settingsBody({ ...settings, codingAgents: { agents: ["cmux"], claudeSurface: "web" } }).codingAgents)
      .toEqual({ agents: ["cmux"], claudeSurface: "web" });
  });
});
