import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handoffScript, ideHandoffRoutes } from "./ide-handoff.js";

function render(hash: string) {
  const elements = {
    open: { hidden: true, href: "" },
    prompt: { hidden: true, value: "" },
    status: { textContent: "" },
  };
  runInNewContext(handoffScript, {
    URLSearchParams, location: { hash },
    document: { getElementById: (id: keyof typeof elements) => elements[id] },
  });
  return elements;
}

describe("desktop handoff page", () => {
  it("serves a static page without authentication, tracking, or query interpolation", async () => {
    const response = await ideHandoffRoutes.request("/conductor?prompt=%3Cscript%3Eevil%3C%2Fscript%3E");
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(`'sha256-${createHash("sha256").update(handoffScript).digest("base64")}'`);
    const html = await response.text();
    expect(html).not.toContain("evil");
    expect(html).toContain('aria-label="Task context"');
    expect(html).not.toContain("innerHTML");
  });

  it("round-trips an untrusted prompt to the documented flat URL scheme", () => {
    const prompt = '<script>alert("x")</script>\nFix & test 🚀';
    const elements = render(`#prompt=${encodeURIComponent(prompt)}`);
    expect(elements.prompt.value).toBe(prompt);
    expect(elements.open.hidden).toBe(false);
    expect(elements.open.href).toBe(`conductor://prompt=${encodeURIComponent(prompt)}`);
  });

  it.each(["", "#prompt=", `#prompt=${"x".repeat(12_001)}`])("keeps invalid handoffs disabled", (hash) => {
    const elements = render(hash);
    expect(elements.open.hidden).toBe(true);
    expect(elements.status.textContent).toContain("no valid context");
  });
});
