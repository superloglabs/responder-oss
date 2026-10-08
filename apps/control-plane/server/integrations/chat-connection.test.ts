import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { chatConnectionRoutes, chatConnectionHandoffUrl, createChatConnectionTicket, chatReturnUrl } from "./chat-connection.js";
import { getActiveTenant } from "../tenant.js";
import { listOrganizationIntegrationAccounts } from "../../../../packages/core/src/db/integrations.js";

vi.mock("../tenant.js", () => ({ getActiveTenant: vi.fn() }));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({ listOrganizationIntegrationAccounts: vi.fn() }));
const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const app = new Hono().route("/api/integrations/chat", chatConnectionRoutes);
const returnUrl = "https://chatgpt.com/c/test-conversation";

describe("chat connection return", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("BETTER_AUTH_URL", "https://superlog.example");
    vi.mocked(getActiveTenant).mockResolvedValue({ ok: true, organizationId, role: "member", user: { id: userId, name: "Test", email: "test@example.com" } });
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([]);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  async function open(provider = "slack") {
    const ticket = createChatConnectionTicket({ userId, organizationId, provider });
    const handoff = new URL(chatConnectionHandoffUrl(ticket.token, "https://slack.com/oauth/v2/authorize?state=provider-state"));
    handoff.searchParams.set("redirectUrl", returnUrl);
    const response = await app.request(handoff);
    return { ticket, handoff, response, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
  }

  it("stores the host return address in a protected cookie without forwarding it to Slack", async () => {
    const { response, cookie } = await open();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://slack.com/oauth/v2/authorize?state=provider-state");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(cookie).not.toContain(returnUrl);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("returns to the original chat only after checking the connected account", async () => {
    const { ticket, cookie } = await open();
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([{ provider: "slack", status: "connected" }] as never);
    const response = await app.request(ticket.returnTo + "&status=connected", { headers: { cookie } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(returnUrl);
    expect(listOrganizationIntegrationAccounts).toHaveBeenCalledWith(organizationId);
  });

  it("does not trust a success query when no account is connected", async () => {
    const { ticket, cookie } = await open();
    const response = await app.request(ticket.returnTo + "&status=connected", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("isn’t connected yet");
  });

  it("shows a focused success page when no host return address exists", async () => {
    const { ticket } = await open();
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([{ provider: "slack", status: "connected" }] as never);
    const response = await app.request(ticket.returnTo + "&status=connected");
    expect(await response.text()).toContain("Slack connected");
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects a different user, tampered handoff, and expired ticket", async () => {
    const { handoff, ticket } = await open();
    vi.mocked(getActiveTenant).mockResolvedValueOnce({ ok: true, organizationId, role: "member", user: { id: "33333333-3333-4333-8333-333333333333", name: "Other", email: "other@example.com" } });
    expect((await app.request(handoff)).status).toBe(403);
    handoff.searchParams.set("token", "tampered");
    expect((await app.request(handoff)).status).toBe(400);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
    expect((await app.request(ticket.returnTo)).status).toBe(400);
  });

  it("preserves the required Google Cloud project-selection step", async () => {
    const { ticket } = await open("gcp");
    const response = await app.request(ticket.returnTo + "&status=select_project&integration=gcp&selection_state=selection");
    const url = new URL(response.headers.get("location")!);
    expect(url.pathname).toBe("/settings");
    expect(url.searchParams.get("selection_state")).toBe("selection");
    expect(url.searchParams.has("ticket")).toBe(false);
  });

  it.each(["https://evil.example", "https://chatgpt.com.evil.example/c/a", "https://chatgpt.com@evil.example", "javascript:alert(1)", "http://chatgpt.com", "codex://settings", "https://chatgpt.com:999/c/a"])("rejects unsafe return URL %s", (url) => {
    expect(chatReturnUrl(url)).toBeNull();
  });
});
