import type { ReactNode } from "react";
import { IconButton } from "../design-system";
import { CogIcon, ProviderGlyph } from "./icons";
import type { ProviderGlyphId } from "./provider-glyphs";

type ProviderId = Exclude<ProviderGlyphId, "google">;

export function AgentContextProviderMark({
  connected = false,
  provider,
}: {
  connected?: boolean;
  provider: ProviderId;
}) {
  return (
    <ProviderGlyph
      className={`providerMark providerMark--${provider} ${
        connected ? "isConnected" : ""
      }`}
      decorative
      provider={provider}
    />
  );
}

export function AgentContextRow({
  action,
  detail,
  label,
  provider,
}: {
  action: ReactNode;
  detail: string;
  label: string;
  provider: ProviderId;
}) {
  return (
    <div className="contextRow">
      <AgentContextProviderMark provider={provider} />
      <span className="contextRow__copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <span className="contextRow__action">{action}</span>
    </div>
  );
}

export function AgentContextIntegrationControls({
  disabled = false,
  enabled,
  label,
  onConfigure,
  onToggle,
  toggleAriaLabel,
}: {
  disabled?: boolean;
  enabled: boolean;
  label: string;
  onConfigure?: () => void;
  onToggle: () => void;
  toggleAriaLabel?: string;
}) {
  return (
    <div className="contextIntegrationControls">
      {onConfigure ? (
        <IconButton
          aria-label={`Configure ${label}`}
          disabled={disabled}
          onClick={onConfigure}
          size="small"
          type="button"
          variant="ghost"
        >
          <CogIcon />
        </IconButton>
      ) : null}
      <button
        aria-checked={enabled}
        aria-label={
          toggleAriaLabel ??
          `${enabled ? "Disable" : "Enable"} ${label} for this agent`
        }
        className="contextIntegrationToggle"
        disabled={disabled}
        onClick={onToggle}
        role="switch"
        type="button"
      >
        <i aria-hidden="true"><i /></i>
      </button>
    </div>
  );
}
