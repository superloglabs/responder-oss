import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CopySimpleIcon, GithubLogoIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { authClient } from "../auth-client";
import { fetchSharedAutomationTemplate, type SharedAutomationTemplate } from "../automations-api";
import { AppShell } from "../components/app-shell";
import { AutomationTriggerIcon } from "../components/automation-trigger-icon";
import { ProviderGlyph } from "../components/icons";
import { providerDisplayName, providerGlyphs, type ProviderGlyphId } from "../components/provider-glyphs";
import { AutomationEditorSkeleton } from "../components/screen-skeletons";
import { useDocumentTitle } from "../use-document-title";
import { triggerTitle } from "./automation-list-presentation";
import { sharedTemplateSetupPath, sharedTriggerDescription } from "./shared-automation-template-presentation";
import "../components/automation-trigger-editor.css";
import "./automation-create.css";
import "./shared-automation-template.css";

function isGlyph(provider: string): provider is ProviderGlyphId {
  return provider in providerGlyphs;
}

// The public, read-only view of an automation another workspace shared. It
// uses the automation page's layout so visitors see the product as members
// do. Setting it up goes through sign-in and opens the create page with the
// template applied.
export function SharedAutomationTemplatePage() {
  const { slug = "" } = useParams();
  const session = authClient.useSession();
  const signedIn = Boolean(session.data);
  const [template, setTemplate] = useState<SharedAutomationTemplate | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  useDocumentTitle(template ? template.name : "Automation template");

  useEffect(() => {
    let cancelled = false;
    void fetchSharedAutomationTemplate(slug)
      .then((loaded) => {
        if (cancelled) return;
        setTemplate(loaded);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setStatus(cause instanceof Error && cause.message === "Template not found" ? "missing" : "error");
      });
    return () => { cancelled = true; };
  }, [slug]);

  const setupPath = sharedTemplateSetupPath(slug);
  const guest = session.isPending || signedIn ? undefined : <div className="sharedTemplate__guest">
    <Link className="dsButton dsButton--primary dsButton--small" to={setupPath}>Get started</Link>
    <Link className="sharedTemplate__signIn" to="/automations">Sign in</Link>
  </div>;
  const connectors = template?.connectors.filter((provider) => provider !== "github") ?? [];

  return (
    <AppShell active="automations" density="create" guest={guest} redesigned>
      {status === "loading" ? <AutomationEditorSkeleton /> : null}
      {status === "missing" || status === "error" ? <section className="emptyState">
        <h1>{status === "missing" ? "This template is no longer shared" : "Unable to load this template"}</h1>
        <p>{status === "missing" ? "The workspace that shared it stopped sharing, or the link is incomplete." : "Check your connection and reload the page."}</p>
        <Link to="/automations">Go to automations</Link>
      </section> : null}
      {template ? <div className="automationCreate">
        <header className="automationCreate__header">
          <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb"><Link to="/automations">Automations</Link><span aria-hidden="true">›</span><span>Shared template</span></nav>
          <div className="automationCreate__titleRow">
            <h1>{template.name}</h1>
            <span className="automationCreate__spacer" />
            <Link className="automationCreate__save sharedTemplate__use" to={setupPath}><CopySimpleIcon size={14} />Use this automation</Link>
          </div>
        </header>
        <div className="automationCreate__template" role="status">
          <SquaresFourIcon aria-hidden="true" size={16} />
          <p>
            Shared by {template.workspaceName}.{" "}
            {signedIn ? "Use it to add a copy to your workspace." : "Create an account to set up a copy in your own workspace."}
            {template.description ? <span className="sharedTemplate__description">{template.description}</span> : null}
          </p>
        </div>
        <div className="automationCreate__form">
          <section aria-labelledby="shared-template-triggers" className="automationCreate__section automationCreate__section--trigger">
            <h2 id="shared-template-triggers">Triggers</h2>
            <div className="automationTrigger">
              {template.triggers.map((trigger, index) => trigger.kind === "schedule"
                ? <div className="automationTrigger__card" key={index}>
                    <div className="automationTrigger__heading">
                      <AutomationTriggerIcon kind="schedule" />
                      <span className="automationTrigger__provider">Schedule</span>
                      <span className="automationTrigger__account">Your time zone</span>
                    </div>
                    <p className="sharedTemplate__triggerDetail">{sharedTriggerDescription(trigger)}</p>
                  </div>
                : <div className="automationTrigger__disconnected" key={index}>
                    <div className="automationTrigger__connectionCopy">
                      <div><AutomationTriggerIcon kind={trigger.kind} /><span>{triggerTitle(trigger)}</span></div>
                      <p>{sharedTriggerDescription(trigger)}</p>
                    </div>
                  </div>)}
            </div>
          </section>
          <section aria-labelledby="shared-template-instructions" className="automationCreate__section">
            <h2 id="shared-template-instructions">Agent instructions</h2>
            <div className="automationCreate__instructions">
              <textarea aria-labelledby="shared-template-instructions" readOnly value={template.prompt} />
            </div>
          </section>
          {template.connectors.includes("github") ? <section aria-labelledby="shared-template-repositories" className="automationCreate__section">
            <h2 id="shared-template-repositories">Repositories</h2>
            <div className="automationCreate__rows">
              <div className="automationCreate__row"><GithubLogoIcon size={16} weight="fill" /><span>Your repositories</span><span className="sharedTemplate__rowHint">Chosen when you set it up</span></div>
            </div>
          </section> : null}
          {connectors.length ? <section aria-labelledby="shared-template-connectors" className="automationCreate__section">
            <h2 id="shared-template-connectors">Connectors</h2>
            <div className="automationCreate__rows">
              {connectors.map((provider) => <div className="automationCreate__row" key={provider}>
                {isGlyph(provider) ? <ProviderGlyph decorative provider={provider} /> : null}
                <span>{providerDisplayName(provider)}</span>
                <span className="sharedTemplate__rowHint">Connected when you set it up</span>
              </div>)}
            </div>
          </section> : null}
        </div>
      </div> : null}
    </AppShell>
  );
}
