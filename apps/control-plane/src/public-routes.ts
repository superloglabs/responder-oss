export const blogArticlePath =
  "/blog/kill-alert-fatigue-automating-on-call-with-ai";

export const publicDocumentRoutes = [
  { output: "index.html", pathname: "/" },
  { output: "blog/index.html", pathname: "/blog" },
  {
    output: "blog/kill-alert-fatigue-automating-on-call-with-ai/index.html",
    pathname: blogArticlePath,
  },
] as const;

export const publicDocumentPathnames = publicDocumentRoutes.map(
  ({ pathname }) => pathname,
);
