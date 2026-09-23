import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useColorTheme } from "../color-theme";

export function ColorThemeToggle({ className }: { className: string }) {
  const { theme, toggleTheme } = useColorTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <button
      aria-label={`Switch to ${nextTheme} mode`}
      className={className}
      onClick={toggleTheme}
      title={`Switch to ${nextTheme} mode`}
      type="button"
    >
      {theme === "dark" ? (
        <SunIcon aria-hidden="true" size={16} />
      ) : (
        <MoonIcon aria-hidden="true" size={16} />
      )}
    </button>
  );
}
