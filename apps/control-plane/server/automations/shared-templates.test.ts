import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedAutomationTemplateRoutes, sharedTemplateDocument } from "./shared-templates.js";

const mocks = vi.hoisted(() => ({ getTemplate: vi.fn() }));
vi.mock("../../../../packages/core/src/db/shared-automation-templates.js", () => ({
  getSharedAutomationTemplate: mocks.getTemplate,
}));

const app = new Hono().route("/api/automation-templates", sharedAutomationTemplateRoutes);
const slug = "aB3_-xYz09aB3_-x";

describe("public shared automation templates", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a shared template without a session", async () => {
    mocks.getTemplate.mockResolvedValue({ name: "Triage", slug, workspaceName: "Acme" });

    const response = await app.request(`/api/automation-templates/${slug}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ template: { name: "Triage", slug, workspaceName: "Acme" } });
    expect(mocks.getTemplate).toHaveBeenCalledWith(slug);
  });

  it("returns not found for a stopped share", async () => {
    mocks.getTemplate.mockResolvedValue(null);

    const response = await app.request(`/api/automation-templates/${slug}`);

    expect(response.status).toBe(404);
  });

  it("does not query for a malformed slug", async () => {
    const response = await app.request("/api/automation-templates/short");

    expect(response.status).toBe(404);
    expect(mocks.getTemplate).not.toHaveBeenCalled();
  });
});

describe("shared template document", () => {
  const shell = `<!doctype html>
<html lang="en">
  <head>
    <meta
      name="description"
      content="Managed incident investigation agents."
    />
    <title>Responder</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

  it("renders the template into the head for link previews", () => {
    const html = sharedTemplateDocument(shell, { description: "Rates new issues.", name: "Triage", slug }, "https://superlog.sh");

    expect(html).toContain("<title>Triage · Automation template · Superlog</title>");
    expect(html).toContain('<meta property="og:title" content="Triage">');
    expect(html).toContain('<meta name="description" content="Rates new issues.">');
    expect(html).toContain(`<link rel="canonical" href="https://superlog.sh/templates/${slug}">`);
    expect(html).not.toContain("Managed incident investigation agents.");
    expect(html).not.toContain("<title>Responder</title>");
  });

  it("escapes template text", () => {
    const html = sharedTemplateDocument(shell, { description: "", name: `"><script>alert(1)</script>`, slug }, "https://superlog.sh");

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).toContain("Set up the &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; automation");
  });
});
