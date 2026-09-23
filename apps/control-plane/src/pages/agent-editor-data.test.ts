import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAgent, fetchAgentOptions, fetchIntegrations } from "../agents-api";
import { loadAgentEditorData, unsupportedAgentConfiguration } from "./agent-editor-data";
import type { AgentConfiguration, AgentDetail } from "../agents-api";
vi.mock("../agents-api", () => ({ fetchAgent: vi.fn(), fetchAgentOptions: vi.fn(), fetchIntegrations: vi.fn() }));
afterEach(() => vi.resetAllMocks());
describe("agent detail availability", () => {
  it("keeps run history available when editor options fail", async () => {
    const agent = { id: "agent", investigations: [{ id: "run" }] } as AgentDetail;
    vi.mocked(fetchAgent).mockResolvedValue(agent);
    vi.mocked(fetchAgentOptions).mockRejectedValue(new Error("Options unavailable"));
    vi.mocked(fetchIntegrations).mockResolvedValue([]);
    const result = await loadAgentEditorData("agent");
    expect(result.agent).toEqual(agent);
    expect(result.settingsError).toContain("Options unavailable");
    expect(result.options).toEqual({ accounts: [], resources: [], repositories: [], secrets: [] });
  });
  it("keeps agent data and options when integrations fail", async () => {
    const agent = { id: "agent", investigations: [] } as unknown as AgentDetail;
    const options = { accounts: [], resources: [], repositories: [], secrets: [] };
    vi.mocked(fetchAgentOptions).mockResolvedValue(options);
    vi.mocked(fetchIntegrations).mockRejectedValue(new Error("Integrations unavailable"));
    const result = await loadAgentEditorData("agent", agent);
    expect(result).toEqual({ agent, options, integrations: [], settingsError: "Integrations unavailable" });
    expect(fetchAgent).not.toHaveBeenCalled();
  });
  it("passes successful editor data through without a settings error", async () => {
    const options = { accounts: [], resources: [], repositories: [], secrets: [] };
    const integrations = [{ id: "slack" }] as Awaited<ReturnType<typeof fetchIntegrations>>;
    vi.mocked(fetchAgentOptions).mockResolvedValue(options);
    vi.mocked(fetchIntegrations).mockResolvedValue(integrations);
    const result = await loadAgentEditorData();
    expect(result).toEqual({ agent: null, options, integrations, settingsError: null });
    expect(fetchAgent).not.toHaveBeenCalled();
  });
  it("does not hide agent loading errors behind optional data", async () => {
    vi.mocked(fetchAgent).mockRejectedValue(new Error("Agent not found"));
    vi.mocked(fetchAgentOptions).mockResolvedValue({ accounts: [], resources: [], repositories: [], secrets: [] });
    vi.mocked(fetchIntegrations).mockResolvedValue([]);
    await expect(loadAgentEditorData("agent")).rejects.toThrow("Agent not found");
  });
});
describe("protecting existing configuration variants", () => {
  it.each(["datadog_monitor", "slack_mention"])("blocks lossy editing of %s", (kind) => {
    expect(unsupportedAgentConfiguration({ trigger: { kind }, reporting: { mode: "thread" } } as AgentConfiguration)).toBeTruthy();
  });
  it("blocks lossy editing of combined reporting", () => {
    expect(unsupportedAgentConfiguration({ trigger: { kind: "slack_channel" }, reporting: { mode: "both" } } as AgentConfiguration)).toBeTruthy();
  });
  it("allows the supported input and output combination", () => {
    expect(unsupportedAgentConfiguration({ trigger: { kind: "sentry_issue" }, reporting: { mode: "output_channel" } } as AgentConfiguration)).toBeNull();
  });
});
