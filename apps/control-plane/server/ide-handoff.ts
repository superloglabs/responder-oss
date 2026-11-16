import { type Context, Hono } from "hono";

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

// The "Copy prompt" button's page: Slack buttons cannot write to the
// clipboard, so the copy happens here, on the person's click.
export const promptScript = `
const prompt = new URLSearchParams(location.hash.slice(1)).get("prompt");
const copy = document.getElementById("copy");
const preview = document.getElementById("prompt");
const status = document.getElementById("status");
if (prompt && prompt.length <= 12000) {
  preview.value = prompt;
  preview.hidden = false;
  copy.hidden = false;
  status.textContent = "Copy this prompt into the coding agent of your choice.";
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(prompt).then(
      () => { copy.textContent = "Copied"; },
      () => { preview.select(); status.textContent = "Copying was blocked. The prompt is selected; copy it with your keyboard."; },
    );
  });
} else {
  status.textContent = "This link has no valid context. Open the button from the original notification.";
}
`;

const pageStyle = "body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:64px auto;padding:0 24px;color:#1f2937;background:#fafafa}h1{font-size:28px}a,button{display:inline-block;background:#1f2937;color:white;padding:10px 18px;border:0;border-radius:6px;margin:12px 0;font:inherit;cursor:pointer}textarea{box-sizing:border-box;width:100%;height:360px;padding:16px;font:14px/1.5 ui-monospace,monospace;border:1px solid #9ca3af;border-radius:6px}a[hidden],button[hidden],textarea[hidden]{display:none}";

function script(code: string) {
  return (context: Context) => {
    context.header("Content-Type", "application/javascript; charset=UTF-8");
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    return context.body(code);
  };
}

function page(title: string, body: string) {
  return (context: Context) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Robots-Tag", "noindex, nofollow");
    context.header("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    return context.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${pageStyle}</style></head>
<body>${body}</body></html>`);
  };
}

export const ideHandoffRoutes = new Hono()
  .get("/conductor.js", script(handoffScript))
  .get("/conductor", page("Open in Conductor", `<main><h1>Open in Conductor</h1><p id="status">JavaScript is required to open this handoff.</p><a id="open" hidden>Open Conductor</a><p>Conductor must be installed. You can also copy the context below into an existing workspace.</p><textarea id="prompt" aria-label="Task context" readonly hidden></textarea></main><script src="/api/ide/conductor.js" defer></script>`))
  .get("/prompt.js", script(promptScript))
  .get("/prompt", page("Copy prompt", `<main><h1>Copy prompt</h1><p id="status">JavaScript is required to show this prompt.</p><button id="copy" type="button" hidden>Copy prompt</button><textarea id="prompt" aria-label="Task context" readonly hidden></textarea></main><script src="/api/ide/prompt.js" defer></script>`));
