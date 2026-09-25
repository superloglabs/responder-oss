import { Hono } from "hono";
import { sharedAutomationTemplateSlugSchema } from "../../../../packages/core/src/automations/shared-template.js";
import { getSharedAutomationTemplate } from "../../../../packages/core/src/db/shared-automation-templates.js";

// Public, unauthenticated reads of shared automation templates. The slug is
// the only key; a stopped share returns not found.
export const sharedAutomationTemplateRoutes = new Hono().get(
  "/:slug",
  async (context) => {
    const slug = sharedAutomationTemplateSlugSchema.safeParse(
      context.req.param("slug"),
    );
    if (!slug.success) return context.json({ error: "Template not found" }, 404);
    const template = await getSharedAutomationTemplate(slug.data);
    return template
      ? context.json({ template })
      : context.json({ error: "Template not found" }, 404);
  },
);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Link previews in Slack, X, and similar apps read the HTML head without
// running scripts, so the template's title and description are rendered into
// the application shell on the server.
export function sharedTemplateDocument(
  shell: string,
  template: { description: string; name: string; slug: string },
  baseUrl: string,
): string {
  const title = `${template.name} · Automation template · Superlog`;
  const description =
    template.description ||
    `Set up the ${template.name} automation in your Superlog workspace.`;
  const url = new URL(`/templates/${template.slug}`, baseUrl).toString();
  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Superlog">`,
    `<meta property="og:title" content="${escapeHtml(template.name)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeHtml(template.name)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
  ].join("\n    ");
  return shell
    .replace(/\s*<meta\s+name="description"[\s\S]*?\/?>/, "")
    .replace(/\s*<title>[\s\S]*?<\/title>/, "")
    .replace("</head>", `    ${tags}\n  </head>`);
}
