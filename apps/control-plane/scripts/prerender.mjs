import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  editionSeoMetadataForPath,
  renderPublicRoute,
} from "../.prerender/prerender-entry.js";

const applicationRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distRoot = path.join(applicationRoot, "dist");
const shell = await readFile(path.join(distRoot, "index.html"), "utf8");

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderHead(metadata) {
  const meta = metadata.meta
    .map(
      (tag) =>
        `<meta data-responder-seo="" ${tag.attribute}="${escapeHtml(tag.key)}" content="${escapeHtml(tag.content)}">`,
    )
    .join("\n    ");
  const jsonLd = JSON.stringify(metadata.jsonLd).replaceAll("<", "\\u003c");

  return [
    `<title>${escapeHtml(metadata.title)}</title>`,
    meta,
    `<link data-responder-seo="" rel="canonical" href="${escapeHtml(metadata.canonicalUrl)}">`,
    `<script data-responder-seo="" type="application/ld+json">${jsonLd}</script>`,
  ].join("\n    ");
}

function renderDocument(pathname, metadata) {
  const markup = renderPublicRoute(pathname);
  return shell
    .replace(/\s*<meta\s+name="description"[\s\S]*?\/>/, "")
    .replace(/\s*<title>[\s\S]*?<\/title>/, "")
    .replace("</head>", `    ${renderHead(metadata)}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
}

const routes = [
  { output: "index.html", pathname: "/" },
  { output: "blog/index.html", pathname: "/blog" },
  {
    output: "blog/kill-alert-fatigue-automating-on-call-with-ai/index.html",
    pathname: "/blog/kill-alert-fatigue-automating-on-call-with-ai",
  },
];

await writeFile(path.join(distRoot, "app.html"), shell);

for (const route of routes) {
  const metadata = editionSeoMetadataForPath(route.pathname);
  const output = path.join(distRoot, route.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    metadata ? renderDocument(route.pathname, metadata) : shell,
  );
}

await rm(path.join(applicationRoot, ".prerender"), {
  force: true,
  recursive: true,
});
