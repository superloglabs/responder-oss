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

function ClickStackLogo() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 260 260">
      <rect fill="#f9f9f9" height="260" rx="40" width="260" />
      <rect
        fill="#151515"
        height="175.494"
        rx="2.051"
        width="19.499"
        x="42.25"
        y="42.25"
      />
      <rect
        fill="#151515"
        height="175.494"
        rx="2.051"
        width="19.499"
        x="81.251"
        y="42.25"
      />
      <rect
        fill="#151515"
        height="175.494"
        rx="2.051"
        width="19.499"
        x="120.252"
        y="42.25"
      />
      <rect
        fill="#151515"
        height="175.494"
        rx="2.051"
        width="19.499"
        x="159.243"
        y="42.25"
      />
      <rect
        fill="#151515"
        height="38.999"
        rx="2.051"
        width="19.499"
        x="198.254"
        y="110.501"
      />
    </svg>
  );
}

function DatadogLogo() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path
        d="M19.57 17.04l-1.997-1.316-1.665 2.782-1.937-.567-1.706 2.604.087.82 9.274-1.71-.538-5.794zm-8.649-2.498l1.488-.204c.241.108.409.15.697.223.45.117.97.23 1.741-.16.18-.088.553-.43.704-.625l6.096-1.106.622 7.527-10.444 1.882zm11.325-2.712-.602.115L20.488 0 .789 2.285l2.427 19.693 2.306-.334c-.184-.263-.471-.581-.96-.989-.68-.564-.44-1.522-.039-2.127.53-1.022 3.26-2.322 3.106-3.956-.056-.594-.15-1.368-.702-1.898-.02.22.017.432.017.432s-.227-.289-.34-.683c-.112-.15-.2-.199-.319-.4-.085.233-.073.503-.073.503s-.186-.437-.216-.807c-.11.166-.137.48-.137.48s-.241-.69-.186-1.062c-.11-.323-.436-.965-.343-2.424.6.421 1.924.321 2.44-.439.171-.251.288-.939-.086-2.293-.24-.868-.835-2.16-1.066-2.651l-.028.02c.122.395.374 1.223.47 1.625.293 1.218.372 1.642.234 2.204-.116.488-.397.808-1.107 1.165-.71.358-1.653-.514-1.713-.562-.69-.55-1.224-1.447-1.284-1.883-.062-.477.275-.763.445-1.153-.243.07-.514.192-.514.192s.323-.334.722-.624c.165-.109.262-.178.436-.323a9.762 9.762 0 0 0-.456.003s.42-.227.855-.392c-.318-.014-.623-.003-.623-.003s.937-.419 1.678-.727c.509-.208 1.006-.147 1.286.257.367.53.752.817 1.569.996.501-.223.653-.337 1.284-.509.554-.61.99-.688.99-.688s-.216.198-.274.51c.314-.249.66-.455.66-.455s-.134.164-.259.426l.03.043c.366-.22.797-.394.797-.394s-.123.156-.268.358c.277-.002.838.012 1.056.037 1.285.028 1.552-1.374 2.045-1.55.618-.22.894-.353 1.947.68.903.888 1.609 2.477 1.259 2.833-.294.295-.874-.115-1.516-.916a3.466 3.466 0 0 1-.716-1.562 1.533 1.533 0 0 0-.497-.85s.23.51.23.96c0 .246.03 1.165.424 1.68-.039.076-.057.374-.1.43-.458-.554-1.443-.95-1.604-1.067.544.445 1.793 1.468 2.273 2.449.453.927.186 1.777.416 1.997.065.063.976 1.197 1.15 1.767.306.994.019 2.038-.381 2.685l-1.117.174c-.163-.045-.273-.068-.42-.153.08-.143.241-.5.243-.572l-.063-.111c-.348.492-.93.97-1.414 1.245-.633.359-1.363.304-1.838.156-1.348-.415-2.623-1.327-2.93-1.566 0 0-.01.191.048.234.34.383 1.119 1.077 1.872 1.56l-1.605.177.759 5.908c-.337.048-.39.071-.757.124-.325-1.147-.946-1.895-1.624-2.332-.599-.384-1.424-.47-2.214-.314l-.05.059a2.851 2.851 0 0 1 1.863.444c.654.413 1.181 1.481 1.375 2.124.248.822.42 1.7-.248 2.632-.476.662-1.864 1.028-2.986.237.3.481.705.876 1.25.95.809.11 1.577-.03 2.106-.574.452-.464.69-1.434.628-2.456l.714-.104.258 1.834 11.827-1.424zM15.05 6.848c-.034.075-.085.125-.007.37l.004.014.013.032.032.073c.14.287.295.558.552.696.067-.011.136-.019.207-.023.242-.01.395.028.492.08.009-.048.01-.119.005-.222-.018-.364.072-.982-.626-1.308-.264-.122-.634-.084-.757.068a.302.302 0 0 1 .058.013c.186.066.06.13.027.207m1.958 3.392c-.092-.05-.52-.03-.821.005-.574.068-1.193.267-1.328.372-.247.191-.135.523.047.66.511.382.96.638 1.432.575.29-.038.546-.497.728-.914.124-.288.124-.598-.058-.698m-5.077-2.942c.162-.154-.805-.355-1.556.156-.554.378-.571 1.187-.041 1.646.053.046.096.078.137.104a4.77 4.77 0 0 1 1.396-.412c.113-.125.243-.345.21-.745-.044-.542-.455-.456-.146-.749"
        fill="currentColor"
      />
    </svg>
  );
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

function SentryLogo() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16">
      <path
        d="M8 .67c.26 0 .52.07.74.21.23.13.41.32.54.55l6.52 11.62c.13.23.2.49.2.76 0 .2-.04.4-.11.58l-.08.2c-.13.23-.31.42-.54.55-.22.14-.48.21-.74.21H13v-1.27h1.53c.04 0 .08-.01.12-.03.04-.02.07-.05.09-.09.02-.04.04-.08.04-.12 0-.05-.02-.09-.04-.13L8.22 2.08c-.02-.04-.05-.07-.09-.09-.04-.02-.08-.03-.12-.03-.04 0-.08.01-.12.03-.04.02-.07.05-.09.09L6.3 4.75c1.53 1.03 2.8 2.4 3.7 4 1.01 1.82 1.53 3.87 1.52 5.95v.6H7.58v-.63c.01-1.37-.34-2.72-1-3.92a8.13 8.13 0 0 0-2.26-2.53l-.74 1.32c.71.54 1.3 1.22 1.73 2 .54.97.82 2.05.82 3.16v.63H1.48c-.26 0-.52-.07-.74-.2a1.5 1.5 0 0 1-.54-.56c-.13-.23-.2-.49-.2-.76 0-.27.07-.53.2-.76l.94-1.68c.39.14.76.36 1.07.63l-.94 1.68c-.02.04-.03.08-.03.13 0 .04.01.08.03.12.02.04.05.07.09.09.04.02.08.03.12.03h3.38a5.33 5.33 0 0 0-.78-2.14 5.3 5.3 0 0 0-1.64-1.59L1.91 10l1.97-3.5.53.31a9.3 9.3 0 0 1 3.24 3.34c.67 1.2 1.07 2.54 1.16 3.91h1.48a10.84 10.84 0 0 0-1.37-4.67 10.85 10.85 0 0 0-3.77-3.89l-.54-.32 2.11-3.75c.13-.23.31-.42.54-.55C7.48.74 7.74.67 8 .67Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SlackLogo() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 80 80">
      <path
        d="M21.5 48.3a6.7 6.7 0 1 1-6.7-6.7h6.7v6.7Zm3.3 0a6.7 6.7 0 1 1 13.4 0v16.8a6.7 6.7 0 1 1-13.4 0V48.3Z"
        fill="#e01e5a"
      />
      <path
        d="M31.5 21.4a6.7 6.7 0 1 1 6.7-6.7v6.7h-6.7Zm0 3.4a6.7 6.7 0 1 1 0 13.4H14.7a6.7 6.7 0 1 1 0-13.4h16.8Z"
        fill="#36c5f0"
      />
      <path
        d="M58.4 31.5a6.7 6.7 0 1 1 6.7 6.7h-6.7v-6.7Zm-3.4 0a6.7 6.7 0 1 1-13.4 0V14.7a6.7 6.7 0 1 1 13.4 0v16.8Z"
        fill="#2eb67d"
      />
      <path
        d="M48.3 58.4a6.7 6.7 0 1 1-6.7 6.7v-6.7h6.7Zm0-3.4a6.7 6.7 0 1 1 0-13.4h16.8a6.7 6.7 0 1 1 0 13.4H48.3Z"
        fill="#ecb22e"
      />
    </svg>
  );
}

const providerLogos = {
  clickstack: ClickStackLogo,
  datadog: DatadogLogo,
  github: GithubLogo,
  google: GoogleLogo,
  sentry: SentryLogo,
  slack: SlackLogo,
} as const;

function ProviderGlyphContent({ provider }: { provider: ProviderGlyphId }) {
  const glyph = providerGlyphs[provider];
  if (!("logo" in glyph)) return glyph.text;

  const Logo = providerLogos[glyph.logo];
  return <Logo />;
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
      <ProviderGlyphContent provider={provider} />
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
