import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LangfuseConnectionDialog } from "./langfuse-connection-dialog";

describe("LangfuseConnectionDialog", () => {
  it("links API-key instructions to the selected deployment", () => {
    const markup = renderToStaticMarkup(
      createElement(LangfuseConnectionDialog, {
        connectUrl: "/api/integrations/langfuse/connect",
        onCancel: vi.fn(),
        open: true,
        returnTo: "/settings",
      }),
    );

    expect(markup).toContain('href="https://cloud.langfuse.com/"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("Project Settings → API Keys");
  });
});
