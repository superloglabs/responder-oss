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
        <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="2.5" stroke="currentColor" />
          <path d="M8 1.25v1.5M8 13.25v1.5M1.25 8h1.5M13.25 8h1.5M3.23 3.23l1.06 1.06M11.71 11.71l1.06 1.06M12.77 3.23l-1.06 1.06M4.29 11.71l-1.06 1.06" stroke="currentColor" strokeLinecap="round" />
        </svg>
      ) : (
        <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
          <path d="M12.9 10.2A5.5 5.5 0 0 1 5.8 3.1a5.5 5.5 0 1 0 7.1 7.1Z" stroke="currentColor" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
