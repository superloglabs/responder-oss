import { html } from "hono/html";
import { getOrganizationName } from "../../../../packages/core/src/db/organizations.js";
import { cellOrigin, controlPlaneBaseUrl } from "./urls.js";

// A connection start link acts for whoever opens it: it connects the
// provider account their browser is signed in to, to their active Superlog
// workspace. Superlog's own pages open these links from the same origin. A
// link opened from anywhere else (another site, an email, a chat message)
// gets a page that names the provider and the workspace, and the connection
// starts only from that page's button, which posts back from the same origin.

export function openedFromSameOrigin(headers: Headers): boolean {
  return headers.get("sec-fetch-site") === "same-origin";
}

function origin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Browsers send Sec-Fetch-Site with every form post. Older ones that do not
// still send Origin, which must then be one of this application's addresses.
export function postedFromSameOrigin(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const posted = origin(headers.get("origin") ?? undefined);
  if (!posted) return false;
  return [controlPlaneBaseUrl(), cellOrigin(), process.env.RESPONDER_PUBLIC_URL?.trim()]
    .map(origin)
    .includes(posted);
}

export async function connectionStartConfirmation(input: {
  // The start path and query to post back to.
  action: string;
  organizationId: string;
  providerName: string;
}): Promise<Response> {
  const workspace = (await getOrganizationName(input.organizationId)) ?? "your Superlog workspace";
  const body = html`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect ${input.providerName} · Superlog</title>
    <style>body{margin:0;background:#f8fafc;color:#14253e;font:16px/1.6 system-ui;display:grid;min-height:100vh;place-items:center}main{max-width:440px;padding:36px}small{color:#446386}h1{font-size:28px;line-height:1.2}p{color:#536176}form{display:flex;gap:12px;align-items:center}button{background:#245de1;color:white;border:0;font:inherit;padding:10px 18px;border-radius:9px;cursor:pointer}a{color:#245de1}</style>
    <main><small>Superlog</small><h1>Connect ${input.providerName}?</h1>
    <p>This link connects ${input.providerName} to the Superlog workspace <strong>${workspace}</strong>. Continue only if you started this connection yourself.</p>
    <form method="post" action="${input.action}"><button type="submit">Continue to ${input.providerName}</button><a href="/">Cancel</a></form></main></html>`;
  return new Response(await body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  });
}
