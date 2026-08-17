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
      {provider === "upstash" ? <UpstashIcon /> : glyph.text}
    </span>
  );
}

function UpstashIcon() {
  return (
    <svg
      aria-hidden="true"
      className="providerGlyph__logo"
      fill="none"
      viewBox="0 0 118 118"
    >
      <path
        d="M15.105 103.244c19.416 19.526 50.895 19.526 70.311 0 19.416-19.526 19.416-51.185 0-70.711l-8.789 8.839c14.562 14.645 14.562 38.388 0 53.033-14.562 14.644-38.171 14.644-52.733 0l-8.789 8.839Z"
        fill="#00E9A3"
      />
      <path
        d="M32.683 85.566c9.708 9.763 25.447 9.763 35.155 0 9.708-9.763 9.708-25.592 0-35.355L59.05 59.05c4.854 4.881 4.854 12.796 0 17.677a12.38 12.38 0 0 1-17.578 0l-8.79 8.839Z"
        fill="#00E9A3"
      />
      <path
        d="M102.994 14.855c-19.416-19.526-50.895-19.526-70.311 0-19.416 19.527-19.416 51.185 0 70.711l8.788-8.839c-14.561-14.645-14.561-38.388 0-53.033 14.562-14.644 38.172-14.644 52.734 0l8.789-8.839Z"
        fill="#00E9A3"
      />
      <path
        d="M85.416 32.533c-9.708-9.763-25.448-9.763-35.156 0-9.708 9.763-9.708 25.592 0 35.355l8.79-8.839c-4.855-4.881-4.855-12.795 0-17.677a12.38 12.38 0 0 1 17.577 0l8.789-8.839Z"
        fill="#00E9A3"
      />
      <path
        d="M102.994 14.855c-19.416-19.526-50.896-19.526-70.312 0-19.416 19.527-19.416 51.185 0 70.711l8.79-8.839c-14.563-14.645-14.563-38.388 0-53.033 14.561-14.644 38.17-14.644 52.732 0l8.79-8.839Z"
        fill="#fff"
        fillOpacity=".8"
      />
      <path
        d="M85.416 32.533c-9.708-9.763-25.448-9.763-35.156 0-9.708 9.763-9.708 25.592 0 35.355l8.79-8.839c-4.855-4.881-4.855-12.795 0-17.677a12.38 12.38 0 0 1 17.577 0l8.789-8.839Z"
        fill="#fff"
        fillOpacity=".8"
      />
    </svg>
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
