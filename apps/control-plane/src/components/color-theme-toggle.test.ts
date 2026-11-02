import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ColorThemeToggle } from "./color-theme-toggle";

const colorTheme = vi.hoisted(() => ({ theme: "dark" as "dark" | "light" }));

vi.mock("../color-theme", () => ({
  useColorTheme: () => ({ theme: colorTheme.theme, toggleTheme: vi.fn() }),
}));

describe("color theme toggle", () => {
  it("names the theme it switches to", () => {
    colorTheme.theme = "dark";
    const html = renderToStaticMarkup(
      createElement(ColorThemeToggle, { className: "globalThemeToggle" }),
    );
    expect(html).toContain('aria-label="Switch to light mode"');
    expect(html).toContain('title="Switch to light mode"');
    expect(html).not.toContain("<span");
  });

  it("shows the action as text for sidebar rows", () => {
    colorTheme.theme = "light";
    const html = renderToStaticMarkup(
      createElement(ColorThemeToggle, {
        className: "globalThemeToggle globalThemeToggle--workspace",
        showLabel: true,
      }),
    );
    expect(html).toContain('class="globalThemeToggle globalThemeToggle--workspace"');
    expect(html).toContain("<span>Switch to dark mode</span>");
  });
});
