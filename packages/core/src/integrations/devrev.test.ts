import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDevRevTicketComment,
  createDevRevTicketWebhook,
  DevRevApiError,
  devrevTicketUrl,
  getDevRevOrganization,
  parseDevRevCredentials,
  verifyDevRevSignature,
} from "./devrev.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("DevRev API", () => {
  it("reads the token's organization", async () => {
    const fetch = vi.fn(async () => jsonResponse({
      dev_org: { dev_slug: "acme", display_name: "Acme", id: "don:identity:dvrv-us-1:devo/1abc" },
    }));

    await expect(getDevRevOrganization("token", fetch)).resolves.toEqual({
      displayName: "Acme",
      id: "don:identity:dvrv-us-1:devo/1abc",
      slug: "acme",
    });
    expect(fetch).toHaveBeenCalledWith("https://api.devrev.ai/dev-orgs.get", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer token" }),
      method: "GET",
    }));
  });

  it("reports a rejected token", async () => {
    const error = await getDevRevOrganization("token", async () => jsonResponse({}, 401)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DevRevApiError);
    expect((error as DevRevApiError).unauthorized).toBe(true);
  });

  it("registers a webhook for new work items", async () => {
    const fetch = vi.fn(async () => jsonResponse({ webhook: { id: "webhook-1", secret: "secret-1", status: "unverified" } }, 201));

    await expect(createDevRevTicketWebhook({ token: "token", url: "https://responder.example/api/webhooks/devrev/account" }, fetch))
      .resolves.toEqual({ id: "webhook-1", secret: "secret-1" });
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      event_types: ["work_created"],
      url: "https://responder.example/api/webhooks/devrev/account",
    });
  });

  it("posts ticket comments as internal", async () => {
    const fetch = vi.fn(async () => jsonResponse({ timeline_entry: { id: "comment" } }, 201));

    await createDevRevTicketComment({ body: "Done", ticketId: "don:core:ticket", token: "token" }, fetch);

    expect(fetch).toHaveBeenCalledWith("https://api.devrev.ai/timeline-entries.create", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      body: "Done",
      body_type: "text",
      object: "don:core:ticket",
      type: "timeline_comment",
      visibility: "internal",
    });
  });
});

describe("verifyDevRevSignature", () => {
  const body = JSON.stringify({ type: "work_created" });
  const signature = createHmac("sha256", "secret").update(body).digest("hex");

  it("accepts the hex HMAC of the raw body", () => {
    expect(verifyDevRevSignature({ body, secret: "secret", signature })).toBe(true);
  });

  it("rejects a missing, different, or tampered signature", () => {
    expect(verifyDevRevSignature({ body, secret: "secret", signature: undefined })).toBe(false);
    expect(verifyDevRevSignature({ body, secret: "other", signature })).toBe(false);
    expect(verifyDevRevSignature({ body: `${body} `, secret: "secret", signature })).toBe(false);
  });
});

describe("DevRev credentials and links", () => {
  it("accepts a token with or without its webhook", () => {
    expect(parseDevRevCredentials({ authType: "personal_access_token", token: "token" })).toEqual({
      authType: "personal_access_token",
      token: "token",
    });
    expect(() => parseDevRevCredentials({ token: "token" })).toThrow();
  });

  it("links a ticket when the organization slug is known", () => {
    expect(devrevTicketUrl("acme", "TKT-12")).toBe("https://app.devrev.ai/acme/works/TKT-12");
    expect(devrevTicketUrl(null, "TKT-12")).toBeUndefined();
  });
});
