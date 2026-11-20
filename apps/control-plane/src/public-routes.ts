import { editionPublicDocumentPathnames } from "./edition-metadata";

export const blogArticlePath =
  "/blog/kill-alert-fatigue-automating-on-call-with-ai";

const corePublicDocumentPathnames = [
  "/",
  "/enterprise",
  "/blog",
  "/team",
  "/privacy",
  "/tos",
  "/sms",
  blogArticlePath,
  "/blog/quieter-incidents-slack-and-connectors",
];

export function normalizedDocumentPathname(pathname: string) {
  const trimmed = pathname.replace(/\/+$/u, "");
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function documentOutput(pathname: string) {
  return pathname === "/" ? "index.html" : `${pathname.slice(1)}/index.html`;
}

export const publicDocumentPathnames: readonly string[] = [
  ...new Set(
    [...corePublicDocumentPathnames, ...editionPublicDocumentPathnames].map(
      normalizedDocumentPathname,
    ),
  ),
];

export const publicDocumentRoutes = publicDocumentPathnames.map((pathname) => ({
  output: documentOutput(pathname),
  pathname,
}));

// The build renders the application's not-found page to this file. Hosting
// serves it, with a 404 status, for any address that is neither a public page
// nor an application path.
export const notFoundDocument = {
  output: "404.html",
  pathname: "/404",
} as const;
