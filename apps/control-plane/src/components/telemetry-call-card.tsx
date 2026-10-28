import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import {
  dismissTelemetryCall,
  isTelemetryCallDismissed,
  telemetryCallUrl,
} from "../telemetry-call";

export function TelemetryCallCard() {
  const [isDismissed, setIsDismissed] = useState(isTelemetryCallDismissed);
  const bookingUrl = telemetryCallUrl();
  if (!bookingUrl || isDismissed) return null;

  return (
    <aside aria-labelledby="telemetry-call-title" className="telemetryCallCard">
      <button
        aria-label="Dismiss the telemetry storage card"
        className="telemetryCallCard__dismiss"
        onClick={() => {
          dismissTelemetryCall();
          setIsDismissed(true);
        }}
        type="button"
      >
        <XIcon aria-hidden="true" size={12} />
      </button>
      <span className="telemetryCallCard__eyebrow">Telemetry storage</span>
      <h2 className="telemetryCallCard__title" id="telemetry-call-title">
        Your telemetry can live here, too
      </h2>
      <p className="telemetryCallCard__body">
        Store your logs, metrics, and traces in Superlog and give your
        automations the context they need to investigate issues.
      </p>
      <a
        className="telemetryCallCard__action"
        href={bookingUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        Book a call <span aria-hidden="true">→</span>
      </a>
    </aside>
  );
}
