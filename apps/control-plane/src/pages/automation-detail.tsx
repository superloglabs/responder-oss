import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { fetchAutomation, type AutomationDetail } from "../automations-api";
import { AppShell } from "../components/app-shell";
import { Button } from "../design-system";
import { AutomationCreatePage } from "./automation-create";

export function AutomationDetailPage() {
  const { automationId } = useParams();
  return <AutomationDetailContent key={automationId} automationId={automationId} />;
}

function AutomationDetailContent({ automationId }: { automationId?: string }) {
  const [automation, setAutomation] = useState<AutomationDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!automationId) return;
    void fetchAutomation(automationId).then((loaded) => {
      if (!cancelled) setAutomation(loaded);
    }).catch((cause: unknown) => {
      if (cancelled) return;
      const message = cause instanceof Error ? cause.message : "Unable to load automation";
      if (message === "Automation not found") setMissing(true);
      else setError(message);
    });
    return () => { cancelled = true; };
  }, [automationId]);

  if (missing || !automationId) return <Navigate replace to="/automations" />;
  if (automation) return <AutomationCreatePage key={automation.id} initialAutomation={automation} />;
  return <AppShell active="automations" redesigned density="create"><section className="emptyState">
    <h1>{error ? "Unable to load automation" : "Loading automation…"}</h1>
    {error ? <><p>{error}</p><Button onClick={() => window.location.reload()} variant="secondary">Retry</Button><Link to="/automations">Back to automations</Link></> : null}
  </section></AppShell>;
}

// Editing happens on the detail page.
export function AutomationEditRedirect() {
  const { automationId } = useParams();
  return <Navigate replace to={automationId ? `/automations/${automationId}` : "/automations"} />;
}
