import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useColorTheme } from "../color-theme";

export function ColorThemeToggle({
  className,
  showLabel = false,
}: {
  className: string;
  // Shows the action as text beside the icon, for sidebar rows.
  showLabel?: boolean;
}) {
  const { theme, toggleTheme } = useColorTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${nextTheme} mode`;

  return (
    <button
      aria-label={label}
      className={className}
      onClick={toggleTheme}
      title={label}
      type="button"
    >
      {theme === "dark" ? (
        <SunIcon aria-hidden="true" size={16} />
      ) : (
        <MoonIcon aria-hidden="true" size={16} />
      )}
      {showLabel ? <span>{label}</span> : null}
    </button>
  );
}
