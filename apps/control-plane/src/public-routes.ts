export const blogArticlePath =
  "/blog/kill-alert-fatigue-automating-on-call-with-ai";

export const publicDocumentRoutes = [
  { output: "index.html", pathname: "/" },
  { output: "blog/index.html", pathname: "/blog" },
  { output: "team/index.html", pathname: "/team" },
  { output: "privacy/index.html", pathname: "/privacy" },
  { output: "tos/index.html", pathname: "/tos" },
  {
    output: "blog/kill-alert-fatigue-automating-on-call-with-ai/index.html",
    pathname: blogArticlePath,
  },
  {
    output: "blog/quieter-incidents-slack-and-connectors/index.html",
    pathname: "/blog/quieter-incidents-slack-and-connectors",
  },
] as const;

export const publicDocumentPathnames = publicDocumentRoutes.map(
  ({ pathname }) => pathname,
);
