import { BugIcon, CalendarDotsIcon } from "@phosphor-icons/react";
import type { AutomationTrigger } from "../automations-api";
import { ProviderGlyph } from "./icons";

// Schedules and error issues have no provider, so they use their own icons.
export function AutomationTriggerIcon({ kind }: { kind: AutomationTrigger["kind"] }) {
  return kind === "schedule"
    ? <CalendarDotsIcon aria-hidden="true" className="automationTriggerIcon--schedule" size={16} />
    : kind === "errors"
      ? <BugIcon aria-hidden="true" className="automationTriggerIcon--schedule" size={16} />
      : <ProviderGlyph decorative provider={kind} />;
}
