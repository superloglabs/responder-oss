import { useState } from "react";
import { Link } from "react-router-dom";
import { SegmentedControl } from "../design-system";
import {
  automationTemplateCategoryLabels,
  automationTemplates,
  type AutomationTemplateCategory,
} from "../pages/automation-templates";
import { triggerEventLabel, triggerProviderLabel } from "../pages/automation-list-presentation";
import { AutomationTriggerIcon } from "./automation-trigger-icon";
import { ProviderGlyph } from "./icons";
import { providerDisplayName } from "./provider-glyphs";

type CategoryFilter = AutomationTemplateCategory | "all";

const filters: Array<{ label: string; value: CategoryFilter }> = [
  { label: "All", value: "all" },
  { label: automationTemplateCategoryLabels.support, value: "support" },
  { label: automationTemplateCategoryLabels.bug_triage, value: "bug_triage" },
  { label: automationTemplateCategoryLabels.scans, value: "scans" },
];

// Suggested automations shown under the automation list. Choosing one opens
// the create page with the template applied.
export function AutomationTemplateGallery() {
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const templates = automationTemplates.filter((template) => filter === "all" || template.category === filter);

  return (
    <section aria-labelledby="automation-templates" className="automationTemplates">
      <header className="automationTemplates__header">
        <div>
          <h2 id="automation-templates">Start from a template</h2>
          <p>Prefilled triggers, instructions and connectors. Review and save.</p>
        </div>
        <SegmentedControl aria-label="Template category" onChange={setFilter} options={filters} value={filter} />
      </header>
      <ul className="automationTemplates__grid">
        {templates.map((template) => {
          const { trigger } = template;
          const providers = trigger.kind === "schedule" ? template.connectors : [trigger.kind, ...template.connectors];
          return (
            <li key={template.id}>
              <Link className="automationTemplate" to={`/automations/new?template=${template.id}`}>
                <span className="automationTemplate__body">
                  <span className="automationTemplate__top">
                    <span className="automationTemplate__icon"><AutomationTriggerIcon kind={trigger.kind} /></span>
                    <span className="automationTemplate__category">{automationTemplateCategoryLabels[template.category]}</span>
                  </span>
                  <strong>{template.name}</strong>
                  <span className="automationTemplate__description">{template.description}</span>
                </span>
                <span className="automationTemplate__footer">
                  <span>{triggerProviderLabel(trigger)} · {triggerEventLabel(trigger)}</span>
                  <span className="automationTemplate__connectors">
                    <span className="srOnly">Uses {providers.map(providerDisplayName).join(", ")}</span>
                    {providers.map((provider) => <ProviderGlyph decorative key={provider} provider={provider} />)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
