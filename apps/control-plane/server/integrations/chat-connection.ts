import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { html } from "hono/html";
import { z } from "zod";
import { encryptCredentials, decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { listOrganizationIntegrationAccounts } from "../../../../packages/core/src/db/integrations.js";
import { getActiveTenant } from "../tenant.js";
import { controlPlaneBaseUrl } from "./urls.js";
import { getIntegrationDefinition, productIntegrationIds } from "./catalog.js";

const ticketSchema = z.object({
  purpose: z.literal("chat-integration-return"), id: z.uuid(),
  organizationId: z.uuid(), userId: z.uuid(), provider: z.enum(productIntegrationIds),
  expiresAt: z.number(),
});

function unpack(token: string | undefined) {
  try { return token ? decryptCredentials(token) : null; } catch { return null; }
}

export function createChatConnectionTicket(input: {
  organizationId: string; userId: string; provider: string;
}) {
  const ticket = ticketSchema.parse({ ...input, purpose: "chat-integration-return",
    id: randomUUID(), expiresAt: Date.now() + 10 * 60 * 1_000 });
  const token = encryptCredentials(ticket);
  return { token, returnTo: `/api/integrations/chat/complete?ticket=${encodeURIComponent(token)}` };
}

export function chatConnectionHandoffUrl(ticket: string, authorizationUrl: string) {
  const url = new URL("/api/integrations/chat/open", controlPlaneBaseUrl());
  url.searchParams.set("token", encryptCredentials({
    purpose: "chat-integration-open", ticket, authorizationUrl,
  }));
  return url.href;
}

// Only the host's documented chat origins and desktop thread links may return
// from consent. Never forward OAuth codes, provider state, or credentials.
export function chatReturnUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port) return null;
    if (url.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(url.hostname)) return url.href;
    if (url.protocol === "codex:" && url.hostname === "threads" &&
        /^\/[0-9a-f-]{36}$/i.test(url.pathname) && !url.search && !url.hash) return url.href;
  } catch { /* Invalid host return URL. */ }
  return null;
}

function page(title: string, message: string, returnUrl: string | null = null) {
  return html`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Superlog</title>
    <style>body{margin:0;background:#f8fafc;color:#14253e;font:16px/1.6 system-ui;display:grid;min-height:100vh;place-items:center}main{max-width:440px;padding:36px}small{color:#446386}h1{font-size:28px;line-height:1.2}a{display:inline-block;background:#245de1;color:white;text-decoration:none;padding:10px 18px;border-radius:9px}p{color:#536176}</style>
    <main><small>Superlog</small><h1>${title}</h1><p>${message}</p>${returnUrl ? html`<a href="${returnUrl}">Back to your conversation</a>` : ""}</main></html>`;
}

export const chatConnectionRoutes = new Hono()
  .use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    await next();
  })
  .get("/open", async (context) => {
    const envelope = unpack(context.req.query("token"));
    const parsed = ticketSchema.safeParse(unpack(typeof envelope?.ticket === "string" ? envelope.ticket : undefined));
    if (envelope?.purpose !== "chat-integration-open" || !parsed.success ||
        parsed.data.expiresAt <= Date.now() || typeof envelope.authorizationUrl !== "string") {
      return context.html(page("This link has expired", "Return to your conversation and request a new connection link."), 400);
    }
    const tenant = await getActiveTenant(context.req.raw.headers);
    const ticket = parsed.data;
    if (!tenant.ok || tenant.user.id !== ticket.userId || tenant.organizationId !== ticket.organizationId) {
      return context.html(page("Use the same Superlog account", "Sign in to the Superlog workspace you connected in chat, then reopen this connection link."), 403);
    }
    const returnUrl = chatReturnUrl(context.req.query("redirectUrl"));
    if (returnUrl) setCookie(context, `superlog-chat-${ticket.id}`, encryptCredentials({ ticket: envelope.ticket, returnUrl }), {
      httpOnly: true, secure: new URL(controlPlaneBaseUrl()).protocol === "https:",
      sameSite: "Lax", path: "/api/integrations/chat", maxAge: 600,
    });
    return context.redirect(envelope.authorizationUrl);
  })
  .get("/complete", async (context) => {
    const token = context.req.query("ticket");
    const parsed = ticketSchema.safeParse(unpack(token));
    if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
      return context.html(page("Return to your conversation", "Your connection link has expired. Ask the chat to check your connection before trying again."), 400);
    }
    const ticket = parsed.data;
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (!tenant.ok || tenant.user.id !== ticket.userId || tenant.organizationId !== ticket.organizationId) {
      return context.html(page("Use the same Superlog account", "Return to the browser and workspace where you started this connection."), 403);
    }
    // Google Cloud has a second project-selection step in the existing app.
    if (context.req.query("status") === "select_project") {
      const selection = new URL("/settings", controlPlaneBaseUrl());
      for (const [key, value] of new URL(context.req.url).searchParams) {
        if (key !== "ticket") selection.searchParams.set(key, value);
      }
      return context.redirect(selection.href);
    }
    const cookieName = `superlog-chat-${ticket.id}`;
    const receipt = unpack(getCookie(context, cookieName));
    const returnUrl = receipt && receipt.ticket === token ? chatReturnUrl(receipt.returnUrl) : null;
    const accounts = await listOrganizationIntegrationAccounts(ticket.organizationId);
    const connected = context.req.query("status") === "connected" && accounts.some((account) =>
      account.provider === ticket.provider && account.status === "connected");
    const name = getIntegrationDefinition(ticket.provider)?.name ?? "Integration";
    if (connected && returnUrl) {
      deleteCookie(context, cookieName, { path: "/api/integrations/chat" });
      return context.redirect(returnUrl);
    }
    return context.html(page(connected ? `${name} connected` : `${name} isn’t connected yet`,
      connected ? "You’re all set. Return to your conversation to continue setup. You can close this tab."
        : "Return to your conversation to check the connection or try again. Your previous setup is preserved.", returnUrl));
  });
