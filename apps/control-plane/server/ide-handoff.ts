import { Hono } from "hono";

// A separate, static page avoids sending notification content to analytics.
// Use textContent/value, never HTML, for the untrusted URL fragment.
export const handoffScript = `
const prompt = new URLSearchParams(location.hash.slice(1)).get("prompt");
const open = document.getElementById("open");
const preview = document.getElementById("prompt");
const status = document.getElementById("status");
if (prompt && prompt.length <= 12000) {
  preview.value = prompt;
  preview.hidden = false;
  open.href = "conductor://prompt=" + encodeURIComponent(prompt);
  open.hidden = false;
  status.textContent = "Review the context below, then open Conductor and select the correct repository. This starts a new workspace with context from the notification; it does not resume the remote session.";
} else {
  status.textContent = "This link has no valid context. Open the button from the original notification.";
}
`;

export const ideHandoffRoutes = new Hono().get("/conductor.js", (context) => {
  context.header("Content-Type", "application/javascript; charset=UTF-8");
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  return context.body(handoffScript);
}).get("/conductor", (context) => {
  context.header("Cache-Control", "no-store");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Robots-Tag", "noindex, nofollow");
  context.header("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  return context.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open in Conductor</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:64px auto;padding:0 24px;color:#1f2937;background:#fafafa}h1{font-size:28px}a{display:inline-block;background:#1f2937;color:white;padding:10px 18px;border-radius:6px;margin:12px 0}textarea{box-sizing:border-box;width:100%;height:360px;padding:16px;font:14px/1.5 ui-monospace,monospace;border:1px solid #9ca3af;border-radius:6px}a[hidden],textarea[hidden]{display:none}</style></head>
<body><main><h1>Open in Conductor</h1><p id="status">JavaScript is required to open this handoff.</p><a id="open" hidden>Open Conductor</a><p>Conductor must be installed. You can also copy the context below into an existing workspace.</p><textarea id="prompt" aria-label="Task context" readonly hidden></textarea></main><script src="/api/ide/conductor.js" defer></script></body></html>`);
});
