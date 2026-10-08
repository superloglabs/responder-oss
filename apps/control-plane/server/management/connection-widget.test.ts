import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { connectionWidgetHtml } from "./connection-widget.js";

function mount(integrations: { provider: string }[] = [], failFollowUp = false, expiresAt: string | null = null) {
  const elements = Object.fromEntries(["title", "status", "connect", "check"].map(id => [id, {
    textContent: "", disabled: false, hidden: false, onclick: async () => {},
  }]));
  const callTool = vi.fn(async () => ({ structuredContent: { integrations } }));
  const sendFollowUpMessage = vi.fn(async () => { if (failFollowUp) throw Error("unavailable"); });
  const openExternal = vi.fn(async () => {});
  const openai = { toolOutput: { provider: "slack", url: "https://slack.com/oauth/v2/authorize", handoffUrl: "https://superlog.sh/api/integrations/chat/open?token=opaque", status: "awaiting_consent", expiresAt }, callTool, sendFollowUpMessage, openExternal, setWidgetState: vi.fn() };
  runInNewContext(connectionWidgetHtml.split("<script>")[1]!.split("</script>")[0]!, {
    window: { openai, parent: { postMessage: vi.fn() }, addEventListener: vi.fn() },
    document: { getElementById: (id: string) => elements[id], addEventListener: vi.fn() },
    setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
  });
  return { elements, callTool, sendFollowUpMessage, openExternal };
}

describe("connection card", () => {
  it("does not open expired consent links", async () => {
    const card = mount([], false, new Date(Date.now()-1000).toISOString());
    await card.elements.connect.onclick();
    expect(card.openExternal).not.toHaveBeenCalled();
    expect(card.elements.connect.disabled).toBe(true);
    expect(card.elements.status.textContent).toContain("expired");
  });
  it("opens the bound handoff and does not announce success before checking", async () => {
    const card = mount();
    await card.elements.connect.onclick();
    expect(card.openExternal).toHaveBeenCalledWith({ href: "https://superlog.sh/api/integrations/chat/open?token=opaque" });
    await card.elements.check.onclick();
    await vi.waitFor(() => expect(card.callTool).toHaveBeenCalled());
    expect(card.sendFollowUpMessage).not.toHaveBeenCalled();
    expect(card.elements.status.textContent).toContain("Waiting for authorization");
  });
  it("continues only once when the required provider is verified", async () => {
    const card = mount([{ provider: "slack" }]);
    await card.elements.check.onclick();
    await vi.waitFor(() => expect(card.sendFollowUpMessage).toHaveBeenCalledTimes(1));
    await card.elements.check.onclick();
    expect(card.sendFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(card.elements.connect.hidden).toBe(true);
  });
  it("does not confuse another connected provider with completion", async () => {
    const card = mount([{ provider: "github" }]);
    await card.elements.check.onclick();
    await vi.waitFor(() => expect(card.callTool).toHaveBeenCalled());
    expect(card.sendFollowUpMessage).not.toHaveBeenCalled();
  });
  it("offers a manual continuation when the host cannot send a follow-up", async () => {
    const card = mount([{ provider: "slack" }], true);
    await card.elements.check.onclick();
    await vi.waitFor(() => expect(card.elements.status.textContent).toContain("Tell the chat"));
  });
});
