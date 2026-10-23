import { ArrowClockwiseIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  dismissAutomationSuggestion,
  fetchAutomationSuggestions,
  refreshAutomationSuggestions,
  type AutomationSuggestions as AutomationSuggestionsState,
} from "../automations-api";
import { SegmentedControl, Skeleton } from "../design-system";
import {
  automationTemplateCategoryLabels,
  automationTemplates,
  suggestedAutomationTemplates,
  type AutomationTemplate,
  type AutomationTemplateCategory,
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

function AutomationTemplateCard({ onDismiss, reason, template, to }: { onDismiss?: () => void; reason?: string; template: AutomationTemplate; to: string }) {
  const [trigger] = template.triggers;
  const providers = trigger.kind === "schedule" || trigger.kind === "errors" || trigger.kind === "webhook" ? template.connectors : [...new Set([trigger.kind, ...template.connectors])];
  return (
    <>
      <Link className={onDismiss ? "automationTemplate automationTemplate--dismissible" : "automationTemplate"} to={to}>
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
      {onDismiss ? (
        <button aria-label={`Dismiss ${template.name}`} className="automationTemplate__dismiss" onClick={onDismiss} title="Dismiss" type="button">
          <XIcon aria-hidden="true" size={14} />
        </button>
      ) : null}
    </>
  );
}

// Holds a suggestion's place while its replacement is written.
function PendingSuggestionCard() {
  return (
    <span className="automationTemplate automationTemplate--pending">
      <span className="automationTemplate__body">
        <span className="automationTemplate__top"><Skeleton className="automationTemplate__icon" /></span>
        <Skeleton className="automationTemplate__pendingLine" />
        <Skeleton />
        <Skeleton />
      </span>
    </span>
  );
}

const refreshPollMs = 3_000;
// The worker keeps three suggestions shown.
const suggestionCount = 3;

// Templates a model wrote for this workspace this morning. Hidden until the
// first set exists. Using or dismissing one brings a replacement, and Refresh
// replaces all of them.
function AutomationSuggestions() {
  const [state, setState] = useState<AutomationSuggestionsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may set the state, so a slow answer cannot bring
  // back a suggestion dismissed after it was sent.
  const request = useRef(0);

  async function load(send: () => Promise<AutomationSuggestionsState>) {
    const current = ++request.current;
    try {
      const loaded = await send();
      if (current === request.current) setState(loaded);
    } catch (cause) {
      if (current !== request.current) return;
      setError(cause instanceof Error ? cause.message : "Unable to update suggestions");
      setState((previous) => previous && { ...previous, refreshing: false });
    }
  }

  useEffect(() => {
    const current = ++request.current;
    void fetchAutomationSuggestions()
      .then((loaded) => { if (current === request.current) setState(loaded); })
      .catch(() => {});
    return () => { request.current += 1; };
  }, []);

  const refreshing = state?.refreshing ?? false;
  useEffect(() => {
    if (!refreshing) return;
    const timer = setTimeout(() => void load(fetchAutomationSuggestions), refreshPollMs);
    return () => clearTimeout(timer);
  }, [refreshing, state]);

  function dismiss(id: string) {
    setError(null);
    setState((previous) => previous && {
      ...previous,
      refreshing: previous.canRefresh,
      suggestions: previous.suggestions.filter((suggestion) => suggestion.id !== id),
    });
    void load(() => dismissAutomationSuggestion(id));
  }

  function refresh() {
    setError(null);
    setState((previous) => previous && { ...previous, refreshing: true, suggestions: [] });
    void load(refreshAutomationSuggestions);
  }

  if (!state || (!state.suggestions.length && !state.refreshing && !state.canRefresh)) return null;
  const pending = state.refreshing ? Math.max(0, suggestionCount - state.suggestions.length) : 0;
  return (
    <section aria-busy={state.refreshing || undefined} aria-labelledby="automation-suggestions" className="automationTemplates">
      <header className="automationTemplates__header">
        <div>
          <h2 id="automation-suggestions">Suggested for your workspace</h2>
          <p>
            {state.refreshing
              ? "Writing new suggestions from your connected tools, repositories, and recent issues."
              : state.canRefresh
                ? "Written each morning from your connected tools, repositories, and recent issues."
                : "Written each morning from your connected tools, repositories, and recent issues. New ones arrive tomorrow morning."}
          </p>
        </div>
        {state.canRefresh || state.refreshing ? (
          <button className="automationTemplates__refresh" disabled={state.refreshing} onClick={refresh} type="button">
            <ArrowClockwiseIcon aria-hidden="true" size={14} />
            Refresh
          </button>
        ) : null}
      </header>
      {error ? <p className="formError automationTemplates__error" role="alert">{error}</p> : null}
      <ul className="automationTemplates__grid">
        {state.suggestions.map((template) => (
          <li key={template.id}>
            <AutomationTemplateCard
              onDismiss={() => dismiss(template.id)}
              reason={template.reason}
              template={template}
              to={`/automations/new?suggestion=${encodeURIComponent(template.id)}`}
            />
          </li>
        ))}
        {Array.from({ length: pending }, (_, index) => (
          <li aria-hidden="true" key={`pending-${index}`}><PendingSuggestionCard /></li>
        ))}
      </ul>
      {!state.suggestions.length && !state.refreshing ? <p className="automationTemplates__empty">No suggestions right now. Refresh to get new ones.</p> : null}
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
