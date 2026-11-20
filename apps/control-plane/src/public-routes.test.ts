import { describe, expect, it } from "vitest";
import { documentOutput, normalizedDocumentPathname } from "./public-routes";

describe("public document pathnames", () => {
  it("adds a leading slash and drops trailing slashes", () => {
    expect(normalizedDocumentPathname("pricing/")).toBe("/pricing");
    expect(normalizedDocumentPathname("/blog//")).toBe("/blog");
    expect(normalizedDocumentPathname("/")).toBe("/");
    expect(normalizedDocumentPathname("")).toBe("/");
  });

  it("writes each page to its own index.html", () => {
    expect(documentOutput("/")).toBe("index.html");
    expect(documentOutput("/integrations/sentry")).toBe("integrations/sentry/index.html");
  });
});
