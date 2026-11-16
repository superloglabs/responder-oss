import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { handoffScript, ideHandoffRoutes, promptScript } from "./ide-handoff.js";

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
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).not.toContain("evil");
    expect(html).toContain('aria-label="Task context"');
    expect(html).not.toContain("innerHTML");
  });

  it("loads its script from the same origin under the production policy that blocks inline scripts", async () => {
    const html = await (await ideHandoffRoutes.request("/conductor")).text();
    expect(html).toContain('<script src="/api/ide/conductor.js" defer></script>');
    expect(html).not.toContain("<script>");
    const script = await ideHandoffRoutes.request("/conductor.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("application/javascript; charset=UTF-8");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await script.text()).toBe(handoffScript);
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

describe("copy prompt page", () => {
  function renderPrompt(hash: string, writeText: (text: string) => Promise<void>) {
    let onClick: (() => void) | undefined;
    const elements = {
      copy: { hidden: true, textContent: "Copy prompt", addEventListener: (_: string, listener: () => void) => { onClick = listener; } },
      prompt: { hidden: true, value: "", select: () => undefined },
      status: { textContent: "" },
    };
    runInNewContext(promptScript, {
      URLSearchParams, location: { hash }, navigator: { clipboard: { writeText } },
      document: { getElementById: (id: keyof typeof elements) => elements[id] },
    });
    return { elements, click: () => onClick?.() };
  }

  it("serves the same locked-down page with its own script", async () => {
    const response = await ideHandoffRoutes.request("/prompt?prompt=%3Cscript%3Eevil%3C%2Fscript%3E");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).not.toContain("evil");
    expect(html).toContain('<script src="/api/ide/prompt.js" defer></script>');
    expect(await (await ideHandoffRoutes.request("/prompt.js")).text()).toBe(promptScript);
  });

  it("copies the exact prompt on click", async () => {
    const prompt = '<script>alert("x")</script>\nFix & test 🚀';
    const writeText = vi.fn(async () => undefined);
    const { elements, click } = renderPrompt(`#prompt=${encodeURIComponent(prompt)}`, writeText);
    expect(elements.prompt.value).toBe(prompt);
    expect(elements.copy.hidden).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    click();
    await vi.waitFor(() => expect(elements.copy.textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith(prompt);
  });

  it("keeps the copy button hidden without a valid prompt", () => {
    const { elements } = renderPrompt("#prompt=", vi.fn());
    expect(elements.copy.hidden).toBe(true);
    expect(elements.status.textContent).toContain("no valid context");
  });
});
