import { describe, expect, it } from "vitest";
import {
  langfuseBasicAuthorization,
  langfuseMcpUrl,
  langfuseProjectsUrl,
  normalizeLangfuseBaseUrl,
  parseLangfuseCredentials,
} from "./langfuse.js";

describe("Langfuse integration credentials", () => {
  it("normalizes deployment URLs and derives public endpoints", () => {
    expect(normalizeLangfuseBaseUrl("https://cloud.langfuse.com/")).toBe(
      "https://cloud.langfuse.com",
    );
    expect(langfuseProjectsUrl("https://cloud.langfuse.com")).toBe(
      "https://cloud.langfuse.com/api/public/projects",
    );
    expect(langfuseMcpUrl("https://cloud.langfuse.com")).toBe(
      "https://cloud.langfuse.com/api/public/mcp",
    );
  });

  it("rejects deployment URLs containing credentials or API paths", () => {
    expect(() =>
      normalizeLangfuseBaseUrl("https://user:password@langfuse.example.com"),
    ).toThrow("cannot contain credentials");
    expect(() =>
      normalizeLangfuseBaseUrl("https://langfuse.example.com/api/public/mcp"),
    ).toThrow("without an API path");
  });

  it("parses credentials and creates the Basic authorization header", () => {
    expect(
      parseLangfuseCredentials({
        authType: "basic",
        baseUrl: "https://langfuse.example.com/",
        projectId: "project-1",
        publicKey: "pk-lf-public",
        secretKey: "sk-lf-secret",
      }),
    ).toMatchObject({ baseUrl: "https://langfuse.example.com" });
    expect(
      langfuseBasicAuthorization({
        publicKey: "pk-lf-public",
        secretKey: "sk-lf-secret",
      }),
    ).toBe(
      `Basic ${Buffer.from("pk-lf-public:sk-lf-secret").toString("base64")}`,
    );
  });
});
