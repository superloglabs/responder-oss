import type { SVGProps } from "react";
import {
  providerGlyphs,
  type ProviderGlyphId,
} from "./provider-glyphs";

type IconProps = SVGProps<SVGSVGElement>;

interface ProviderGlyphProps {
  className?: string;
  decorative?: boolean;
  provider: ProviderGlyphId;
}

function GithubLogo() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path
        d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.3c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C16 5 17 5.3 17 5.3c.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z"
        fill="currentColor"
      />
    </svg>
  );
}

function GoogleLogo() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path
        d="M22.6 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h5.9a5 5 0 0 1-2.2 3.3v2.8h3.6c2.1-2 3.3-4.8 3.3-8.1Z"
        fill="#4285f4"
      />
      <path
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1a6.5 6.5 0 0 1-6.2-4.5H2.2V17A11 11 0 0 0 12 23Z"
        fill="#34a853"
      />
      <path
        d="M5.8 14.1A6.6 6.6 0 0 1 5.5 12c0-.7.1-1.4.3-2.1V7.1H2.2A11 11 0 0 0 1 12c0 1.8.4 3.5 1.2 4.9l3.6-2.8Z"
        fill="#fbbc05"
      />
      <path
        d="M12 5.4c1.6 0 3.1.6 4.2 1.6l3.2-3.1A10.6 10.6 0 0 0 12 1a11 11 0 0 0-9.8 6.1l3.6 2.8A6.5 6.5 0 0 1 12 5.4Z"
        fill="#ea4335"
      />
    </svg>
  );
}

function ProviderLogo({ provider }: { provider: ProviderGlyphId }) {
  if (provider === "github") return <GithubLogo />;
  if (provider === "google") return <GoogleLogo />;
  return providerGlyphs[provider].text;
}

export function ProviderGlyph({
  className,
  decorative = false,
  provider,
}: ProviderGlyphProps) {
  const glyph = providerGlyphs[provider];
  return (
    <span
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : glyph.label}
      className={`providerGlyph${className ? ` ${className}` : ""}`}
      role={decorative ? undefined : "img"}
    >
      <ProviderLogo provider={provider} />
    </span>
  );
}

export function ArrowIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      viewBox="0 0 16 16"
      width="16"
      {...props}
    >
      <path d="m6 3 5 5-5 5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="15"
      viewBox="0 0 15 15"
      width="15"
      {...props}
    >
      <path d="M7.5 2.5v10M2.5 7.5h10" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      viewBox="0 0 16 16"
      width="16"
      {...props}
    >
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      viewBox="0 0 14 14"
      width="14"
      {...props}
    >
      <path d="m3.5 5.25 3.5 3.5 3.5-3.5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      viewBox="0 0 14 14"
      width="14"
      {...props}
    >
      <path d="M3.5 4.25h7l-.45 7.25h-5.6L4 4.25Z" stroke="currentColor" />
      <path d="M2.5 4.25h9M5.25 2.5h3.5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

export function RepositoryIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="15"
      viewBox="0 0 15 15"
      width="15"
      {...props}
    >
      <path
        d="M3 2.5h7.3a1 1 0 0 1 1 1v8H4a1 1 0 0 1-1-1v-8Z"
        stroke="currentColor"
      />
      <path d="M5 5h4.25M5 7.5h3" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

export function CogIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      viewBox="0 0 16 16"
      width="14"
      {...props}
    >
      <path
        d="M6.7 2.5h2.6l.34 1.42c.38.15.73.35 1.05.61l1.4-.42 1.3 2.24-1.07 1c.06.4.06.82 0 1.22l1.07 1-1.3 2.24-1.4-.42c-.32.26-.67.46-1.05.61L9.3 13.5H6.7L6.36 12a4.6 4.6 0 0 1-1.05-.61l-1.4.42-1.3-2.24 1.07-1a4.1 4.1 0 0 1 0-1.22l-1.07-1 1.3-2.24 1.4.42c.32-.26.67-.46 1.05-.61L6.7 2.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" />
    </svg>
  );
}
