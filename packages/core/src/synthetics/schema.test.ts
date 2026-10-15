import { describe, expect, it } from "vitest";
import { syntheticCheckInputSchema } from "./schema.js";

const valid = { name: "Health", url: "https://example.com/health" };

function problem(input: Record<string, unknown>): string | undefined {
  const parsed = syntheticCheckInputSchema.safeParse({ ...valid, ...input });
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

describe("synthetic check input", () => {
  it("fills the defaults", () => {
    expect(syntheticCheckInputSchema.parse(valid)).toMatchObject({
      assertions: [],
      enabled: true,
      failuresToAlert: 1,
      followRedirects: true,
      intervalSeconds: 300,
      method: "GET",
      retries: 1,
      timeoutMs: 10_000,
    });
  });

  it("accepts only HTTP URLs without credentials", () => {
    expect(problem({ url: "ftp://example.com" })).toBe("The URL must use HTTP or HTTPS");
    expect(problem({ url: "https://user:pass@example.com" })).toBe("Send credentials in a header, not the URL");
    expect(problem({ url: "example.com" })).toMatch(/full URL/u);
  });

  it("rejects headers the request sets, and line breaks in values", () => {
    expect(problem({ headers: [{ name: "Host", value: "evil" }] })).toBe("That header is set by the request");
    expect(problem({ headers: [{ name: "X-Test", value: "a\r\nb" }] })).toBe("Header values cannot contain line breaks");
    expect(problem({ headers: [{ name: "bad name", value: "a" }] })).toMatch(/Header names/u);
  });

  it("checks each assertion's comparison and value", () => {
    expect(problem({ assertions: [{ kind: "status_code", op: "contains", value: "2" }] })).toMatch(/comparison/u);
    expect(problem({ assertions: [{ kind: "status_code", op: "lt", value: "2xx" }] })).toMatch(/Status codes/u);
    expect(problem({ assertions: [{ kind: "header", op: "exists" }] })).toBe("Name the header to check");
    expect(problem({ assertions: [{ key: "$.n", kind: "json_path", op: "gt", value: "many" }] })).toMatch(/number/u);
    expect(problem({ assertions: [{ kind: "status_code", op: "eq", value: "2xx" }] })).toBeUndefined();
  });

  it("refuses a body on GET and an interval it does not offer", () => {
    expect(problem({ body: "{}" })).toBe("GET requests cannot have a body");
    expect(problem({ body: "{}", method: "POST" })).toBeUndefined();
    expect(problem({ intervalSeconds: 30 })).toBe("Choose how often to run the check");
  });
});
