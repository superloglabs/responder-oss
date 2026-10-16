import { SparkleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchAutomationSuggestions } from "../automations-api";
import { SegmentedControl } from "../design-system";
import {
  automationTemplateCategoryLabels,
  automationTemplates,
  suggestedAutomationTemplates,
  type AutomationTemplate,
  type AutomationTemplateCategory,
  type SuggestedAutomationTemplate,
} from "../pages/automation-templates";
import { triggerEventLabel, triggerProviderLabel } from "../pages/automation-list-presentation";
import { AutomationTriggerIcon } from "./automation-trigger-icon";
import { ProviderGlyph } from "./icons";
import { providerDisplayName } from "./provider-glyphs";

type CategoryFilter = AutomationTemplateCategory | "suggested" | "all";

const filters: Array<{ label: string; value: CategoryFilter }> = [
  { label: "Suggested", value: "suggested" },
  { label: "All", value: "all" },
  { label: automationTemplateCategoryLabels.support, value: "support" },
  { label: automationTemplateCategoryLabels.bug_triage, value: "bug_triage" },
  { label: automationTemplateCategoryLabels.scans, value: "scans" },
];

function AutomationTemplateCard({ reason, template, to }: { reason?: string; template: AutomationTemplate; to: string }) {
  const [trigger] = template.triggers;
  const providers = trigger.kind === "schedule" ? template.connectors : [...new Set([trigger.kind, ...template.connectors])];
  return (
    <Link className="automationTemplate" to={to}>
      <span className="automationTemplate__body">
        <span className="automationTemplate__top">
          <span className="automationTemplate__icon"><AutomationTriggerIcon kind={trigger.kind} /></span>
          <span className="automationTemplate__category">{automationTemplateCategoryLabels[template.category]}</span>
        </span>
        <strong>{template.name}</strong>
        <span className="automationTemplate__description">{template.description}</span>
        {reason ? <span className="automationTemplate__reason"><SparkleIcon aria-hidden="true" size={12} weight="fill" />{reason}</span> : null}
      </span>
      <span className="automationTemplate__footer">
        <span>{triggerProviderLabel(trigger)} · {triggerEventLabel(trigger)}</span>
        <span className="automationTemplate__connectors">
          <span className="srOnly">Uses {providers.map(providerDisplayName).join(", ")}</span>
          {providers.map((provider) => <ProviderGlyph decorative key={provider} provider={provider} />)}
        </span>
      </span>
    </Link>
  );
}

// Templates a model wrote for this workspace this morning. Hidden until the
// first set exists.
function AutomationSuggestions() {
  const [suggestions, setSuggestions] = useState<SuggestedAutomationTemplate[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetchAutomationSuggestions()
      .then((loaded) => { if (!cancelled) setSuggestions(loaded); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!suggestions.length) return null;
  return (
    <section aria-labelledby="automation-suggestions" className="automationTemplates">
      <header className="automationTemplates__header">
        <div>
          <h2 id="automation-suggestions">Suggested for your workspace</h2>
          <p>Written each morning from your connected tools, repositories, and recent issues.</p>
        </div>
      </header>
      <ul className="automationTemplates__grid">
        {suggestions.map((template) => (
          <li key={template.id}>
            <AutomationTemplateCard reason={template.reason} template={template} to={`/automations/new?suggestion=${encodeURIComponent(template.id)}`} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// Suggested automations shown under the automation list. Choosing one opens
// the create page with the template applied.
export function AutomationTemplateGallery() {
  const [filter, setFilter] = useState<CategoryFilter>("suggested");
  const templates = filter === "suggested"
    ? suggestedAutomationTemplates
    : automationTemplates.filter((template) => filter === "all" || template.category === filter);

  return (
    <>
      <AutomationSuggestions />
      <section aria-labelledby="automation-templates" className="automationTemplates">
        <header className="automationTemplates__header">
          <div>
            <h2 id="automation-templates">Start from a template</h2>
            <p>Prefilled triggers, instructions and connectors. Review and save.</p>
          </div>
          <SegmentedControl aria-label="Template category" onChange={setFilter} options={filters} value={filter} />
        </header>
        <ul className="automationTemplates__grid">
          {templates.map((template) => (
            <li key={template.id}>
              <AutomationTemplateCard template={template} to={`/automations/new?template=${template.id}`} />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
