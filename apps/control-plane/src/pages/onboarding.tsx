import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, CpuIcon, SparkleIcon } from "@phosphor-icons/react";
import { fetchAutomationCredentials } from "../automations-api";
import { AutomationSubscriptionConnect } from "../components/automation-subscription-connect";
import { DatadogConnectionDialog } from "../components/datadog-site-dialog";
import { ProviderGlyph } from "../components/icons";
import { OnboardingFrame } from "../components/onboarding-frame";
import { providerDisplayName, type ProviderGlyphId } from "../components/provider-glyphs";
import { useIntegrationConnect } from "../components/use-integration-connect";
import { useOrganizationCapabilities } from "../organization-capabilities";
import { homePath } from "../primary-navigation";
import { useDocumentTitle } from "../use-document-title";
import { automationTemplateCategoryLabels } from "./automation-templates";
import {
  onboardingAlertSources,
  onboardingPath,
  onboardingPlanCards,
  onboardingStepFromPath,
  onboardingSteps,
  recommendedTemplates,
  templateProviders,
  type BillingPlanSummary,
  type OnboardingProvider,
  type OnboardingStep,
} from "./onboarding-presentation";

interface OnboardingIntegration {
  accountCount: number;
  connectUrl: string | null;
  id: string;
  resourceCount: number;
}

interface OnboardingBilling {
  automations: (BillingPlanSummary & { configured: boolean; planName: string }) | null;
  enabled: boolean;
  payAsYouGo: boolean;
}

async function fetchIntegrations(signal?: AbortSignal): Promise<OnboardingIntegration[]> {
  const response = await fetch("/api/integrations", { signal });
  if (!response.ok) throw new Error("Unable to load integrations");
  return ((await response.json()) as { integrations: OnboardingIntegration[] }).integrations;
}

// Null when this installation cannot change plans, so the step is skipped.
async function fetchPlanBilling(): Promise<OnboardingBilling | null> {
  const response = await fetch("/api/billing").catch(() => null);
  if (!response?.ok) return null;
  const billing = (await response.json().catch(() => null)) as OnboardingBilling | null;
  return billing?.enabled && billing.automations?.configured ? billing : null;
}

// Guided setup for a new workspace: connect code and alert sources, choose
// a plan, then start an automation from a template that fits what is
// connected. The workspace step runs before the workspace exists, in the
// authentication gate.
export function OnboardingPage() {
  useDocumentTitle("Set up Superlog");
  const capabilities = useOrganizationCapabilities();
  const navigate = useNavigate();
  const { step: stepParameter } = useParams();
  const [integrations, setIntegrations] = useState<OnboardingIntegration[] | null>(null);
  const [billing, setBilling] = useState<OnboardingBilling | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([fetchIntegrations(), fetchPlanBilling()])
      .then(([loadedIntegrations, loadedBilling]) => {
        if (!active) return;
        setIntegrations(loadedIntegrations);
        setBilling(loadedBilling);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Unable to load setup");
      });
    return () => { active = false; };
  }, []);

  // Reports whether the provider has a connection, for the connect popup.
  const refreshIntegrations = useCallback(async (provider: string, signal?: AbortSignal) => {
    const loaded = await fetchIntegrations(signal);
    setIntegrations(loaded);
    return loaded.some((integration) => integration.id === provider && integration.accountCount > 0);
  }, []);

  if (!capabilities.includes("automations")) return <Navigate replace to={homePath(capabilities)} />;

  const steps = onboardingSteps(Boolean(billing));
  const step = onboardingStepFromPath(stepParameter, steps);
  const index = steps.indexOf(step);
  const next = steps[index + 1] as Exclude<OnboardingStep, "workspace"> | undefined;
  const previous = steps[index - 1];
  const finish = homePath(capabilities);
  const goNext = () => navigate(next ? onboardingPath(next) : finish);
  const connected = (integrations ?? []).filter((integration) => integration.accountCount > 0).map((integration) => integration.id);

  const secondaryActions = (
    <span className="onboarding__secondary">
      {previous && previous !== "workspace" ? (
        <Link className="onboarding__link" to={onboardingPath(previous)}><ArrowLeftIcon aria-hidden="true" size={14} />Back</Link>
      ) : null}
      {next ? <Link className="onboarding__link onboarding__link--muted" to={finish}>Skip setup</Link> : null}
    </span>
  );

  if (error || !integrations || billing === undefined) {
    return (
      <OnboardingFrame activeStages={[]} footer={null} step={step} steps={steps}>
        {error ? (
          <div className="onboarding__intro">
            <h1>Setup is unavailable</h1>
            <p>{error}. <Link to={finish}>Continue to Superlog</Link>.</p>
          </div>
        ) : <p className="onboarding__loading">Loading…</p>}
      </OnboardingFrame>
    );
  }

  if (step === "code") {
    const github = integrations.find((integration) => integration.id === "github");
    const githubConnected = Boolean(github && github.accountCount > 0);
    return (
      <OnboardingFrame
        activeStages={["cause", "fix"]}
        connected={connected}
        footer={<>
          {secondaryActions}
          {githubConnected
            ? <button className="onboarding__primary" onClick={goNext} type="button">Continue<ArrowRightIcon aria-hidden="true" size={14} /></button>
            : <button className="onboarding__link" onClick={goNext} type="button">Skip for now<ArrowRightIcon aria-hidden="true" size={14} /></button>}
        </>}
        step={step}
        steps={steps}
      >
        <div className="onboarding__intro">
          <h1>Connect your code</h1>
          <p>Superlog reads your code to find what broke and opens pull requests with the fix.</p>
        </div>
        <ConnectRow
          description={githubConnected
            ? `${github!.resourceCount} ${github!.resourceCount === 1 ? "repository" : "repositories"}`
            : "Install the Superlog GitHub App on the repositories it may read"}
          integration={github}
          onConnected={refreshIntegrations}
          provider="github"
        />
      </OnboardingFrame>
    );
  }

  if (step === "alerts") {
    const groups = onboardingAlertSources
      .map((group) => ({
        label: group.label,
        providers: group.providers.flatMap((provider) => {
          const integration = integrations.find((candidate) => candidate.id === provider);
          // Providers this installation has not configured cannot connect.
          return integration && (integration.connectUrl || integration.accountCount > 0) ? [{ integration, provider }] : [];
        }),
      }))
      .filter((group) => group.providers.length > 0);
    const anyConnected = groups.some((group) => group.providers.some(({ integration }) => integration.accountCount > 0));
    return (
      <OnboardingFrame
        activeStages={["alert"]}
        connected={connected}
        footer={<>
          {secondaryActions}
          <button className={anyConnected ? "onboarding__primary" : "onboarding__link"} onClick={goNext} type="button">
            {anyConnected ? "Continue" : "Skip for now"}<ArrowRightIcon aria-hidden="true" size={14} />
          </button>
        </>}
        step={step}
        steps={steps}
      >
        <div className="onboarding__intro">
          <h1>Where do problems show up?</h1>
          <p>Connect the tools that report errors and the chat where your team talks about them. Superlog starts work from both.</p>
        </div>
        {groups.map((group) => (
          <section aria-label={group.label} className="onboarding__group" key={group.label}>
            <h2>{group.label}</h2>
            <div className="onboarding__tiles">
              {group.providers.map(({ integration, provider }) => (
                <ConnectTile integration={integration} key={provider} onConnected={refreshIntegrations} provider={provider} />
              ))}
            </div>
          </section>
        ))}
        <p className="onboarding__note">More tools, such as Linear, Grafana, and PostHog, are in <Link to="/settings">Integrations</Link>.</p>
      </OnboardingFrame>
    );
  }

  if (step === "plan" && billing?.automations) {
    return (
      <OnboardingFrame footer={secondaryActions} step={step} steps={steps}>
        <PlanStep
          // A saved payment method is charged without a checkout page.
          chargesSavedMethod={billing.payAsYouGo || billing.automations.paid}
          onContinue={goNext}
          returnTo={next ? onboardingPath(next) : finish}
          summary={billing.automations}
        />
      </OnboardingFrame>
    );
  }

  const recommendations = recommendedTemplates(connected);
  return (
    <OnboardingFrame
      footer={<>
        {secondaryActions}
        <Link className="onboarding__link" to={finish}>Go to Superlog<ArrowRightIcon aria-hidden="true" size={14} /></Link>
      </>}
      step={step}
      steps={steps}
    >
      <div className="onboarding__intro">
        <h1>Start your first automation</h1>
        <p>Picked for the tools you connected. Each one opens prefilled, so you only choose the channels and repositories, then save.</p>
      </div>
      <ul className="onboarding__templates">
        {recommendations.map(({ missing, template }) => {
          const providers = templateProviders(template);
          return (
            <li key={template.id}>
              <Link className="onboardingTemplate" to={`/automations/new?template=${template.id}`}>
                <span className="onboardingTemplate__top">
                  <span className="onboardingTemplate__category">{automationTemplateCategoryLabels[template.category]}</span>
                  <span className="onboardingTemplate__providers">
                    <span className="srOnly">Uses {providers.map(providerDisplayName).join(", ")}</span>
                    {providers.map((provider) => (
                      <ProviderGlyph
                        className={missing.includes(provider) ? "isMissing" : undefined}
                        decorative
                        key={provider}
                        provider={provider as ProviderGlyphId}
                      />
                    ))}
                  </span>
                </span>
                <strong>{template.name}</strong>
                <span className="onboardingTemplate__description">{template.description}</span>
                <span className="onboardingTemplate__footer">
                  <span className={missing.length ? "onboardingTemplate__status" : "onboardingTemplate__status isReady"}>
                    {missing.length
                      ? `Connect ${missing.map(providerDisplayName).join(" and ")} while setting up`
                      : <><CheckIcon aria-hidden="true" size={12} />Ready with your tools</>}
                  </span>
                  <span className="onboardingTemplate__action">Set up<ArrowRightIcon aria-hidden="true" size={12} /></span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="onboarding__note">Or <Link to="/automations">browse all templates</Link> and <Link to="/automations/new">start from scratch</Link>.</p>
    </OnboardingFrame>
  );
}

// A single connection with its description, for the code step.
function ConnectRow({ description, integration, onConnected, provider }: {
  description: string;
  integration: OnboardingIntegration | undefined;
  onConnected: (provider: string, signal: AbortSignal) => Promise<boolean>;
  provider: OnboardingProvider;
}) {
  const name = providerDisplayName(provider);
  const { connect, connecting, error } = useIntegrationConnect(provider, name, onConnected);
  const isConnected = Boolean(integration && integration.accountCount > 0);
  return (
    <div className={`onboardingConnection${isConnected ? " isConnected" : ""}`}>
      <span className="onboardingConnection__logo"><ProviderGlyph decorative provider={provider} /></span>
      <span className="onboardingConnection__body">
        <strong>{name}</strong>
        <small>{description}</small>
        {error ? <small className="onboarding__error" role="alert">{error}</small> : null}
      </span>
      {isConnected ? (
        <span className="onboarding__connected"><CheckIcon aria-hidden="true" size={14} />Connected</span>
      ) : (
        <button className="onboarding__button" disabled={connecting || !integration?.connectUrl} onClick={() => void connect()} type="button">
          {connecting ? "Connecting…" : "Connect"}
        </button>
      )}
    </div>
  );
}

// One alert source. OAuth providers connect in a popup so this step stays
// open; Datadog asks for keys and returns here.
function ConnectTile({ integration, onConnected, provider }: {
  integration: OnboardingIntegration;
  onConnected: (provider: string, signal: AbortSignal) => Promise<boolean>;
  provider: OnboardingProvider;
}) {
  const name = providerDisplayName(provider);
  const { connect, connecting, error } = useIntegrationConnect(provider, name, onConnected);
  const [choosingDatadogSite, setChoosingDatadogSite] = useState(false);
  const isConnected = integration.accountCount > 0;
  return (
    <div className={`onboardingTile${isConnected ? " isConnected" : ""}`}>
      <ProviderGlyph decorative provider={provider} />
      <span className="onboardingTile__body">
        <strong>{name}</strong>
        {error ? <small className="onboarding__error" role="alert">{error}</small> : null}
      </span>
      {isConnected ? (
        <span className="onboarding__connected"><CheckIcon aria-hidden="true" size={14} />Connected</span>
      ) : (
        <button
          className="onboarding__textButton"
          disabled={connecting}
          onClick={() => provider === "datadog" ? setChoosingDatadogSite(true) : void connect()}
          type="button"
        >
          {connecting ? "Connecting…" : "Connect"}
        </button>
      )}
      {provider === "datadog" ? (
        <DatadogConnectionDialog
          connectUrl={integration.connectUrl ?? ""}
          onCancel={() => setChoosingDatadogSite(false)}
          open={choosingDatadogSite}
          returnTo={onboardingPath("alerts")}
        />
      ) : null}
    </div>
  );
}

function dollars(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

function PlanStep({ chargesSavedMethod, onContinue, returnTo, summary }: {
  chargesSavedMethod: boolean;
  onContinue: () => void;
  returnTo: string;
  summary: BillingPlanSummary;
}) {
  const cards = onboardingPlanCards(summary);
  const [changingPlan, setChangingPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choosePlan(planId: string, name: string, price: number) {
    if (chargesSavedMethod && !window.confirm(`Switch to ${name} (${dollars(price)} / month) now? A saved payment method is charged immediately, prorated for this period.`)) return;
    setError(null);
    setChangingPlan(planId);
    try {
      const response = await fetch("/api/billing/automations/plan", {
        body: JSON.stringify({ planId, returnTo }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; url?: string | null };
      if (!response.ok) throw new Error(body.error ?? "Unable to change the plan");
      if (body.url) {
        window.location.assign(body.url);
        return;
      }
      onContinue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change the plan");
      setChangingPlan(null);
    }
  }

  return (
    <>
      <div className="onboarding__intro">
        <h1>Choose your plan</h1>
        <p>What you pay comes back as AI usage{cards.some((card) => card.machineHours !== null) ? ". Machine time is included on top." : "."}</p>
      </div>
      {error ? <p className="onboarding__error" role="alert">{error}</p> : null}
      <div className="onboarding__plans">
        {cards.map((card) => (
          <article className={`onboardingPlan${card.recommended ? " isRecommended" : ""}`} key={card.id}>
            <header>
              <h2>{card.name}</h2>
              {card.current ? <span className="onboardingPlan__badge">Current plan</span> : null}
              {card.recommended ? <span className="onboardingPlan__badge onboardingPlan__badge--accent">Recommended</span> : null}
            </header>
            <p className="onboardingPlan__price">{dollars(card.price)}{card.price > 0 ? <small>/mo</small> : null}</p>
            <ul>
              <li><SparkleIcon aria-hidden="true" className="onboardingPlan__credit" size={14} weight="fill" /><span><strong>{dollars(card.credit)}</strong> AI usage {card.creditRenews ? "a month" : "to try"}</span></li>
              {card.machineHours !== null ? <li><CpuIcon aria-hidden="true" size={14} /><span><strong>{card.machineHours} h</strong> machine time a month</span></li> : null}
            </ul>
            {card.current ? (
              <button className="onboarding__button" disabled={changingPlan !== null} onClick={onContinue} type="button">Continue on {card.name}</button>
            ) : (
              <button
                className={card.recommended ? "onboarding__primary" : "onboarding__button"}
                disabled={changingPlan !== null}
                onClick={() => void choosePlan(card.id, card.name, card.price)}
                type="button"
              >
                {changingPlan === card.id ? "Opening checkout…" : `Get ${card.name}`}
              </button>
            )}
          </article>
        ))}
      </div>
      <CodexConnection />
    </>
  );
}

// A ChatGPT subscription runs Codex automations on that plan instead of the
// usage credit.
function CodexConnection() {
  const [state, setState] = useState<"loading" | "connected" | "idle" | "connecting">("loading");
  useEffect(() => {
    let active = true;
    void fetchAutomationCredentials()
      .then((credentials) => {
        if (active) setState(credentials.some((credential) => credential.authType === "chatgpt_subscription") ? "connected" : "idle");
      })
      .catch(() => { if (active) setState("idle"); });
    return () => { active = false; };
  }, []);

  let action: ReactNode = null;
  if (state === "connected") action = <span className="onboarding__connected"><CheckIcon aria-hidden="true" size={14} />Connected</span>;
  else if (state === "idle") action = <button className="onboarding__button" onClick={() => setState("connecting")} type="button">Connect</button>;
  else if (state === "connecting") action = <button className="onboarding__textButton" onClick={() => setState("idle")} type="button">Cancel</button>;

  return (
    <section className="onboardingCodex">
      <div className="onboardingCodex__row">
        <span className="onboardingConnection__logo"><OpenAiMark /></span>
        <span className="onboardingConnection__body">
          <strong>Connect Codex <span className="onboardingPlan__badge">Saves credit</span></strong>
          <small>Already pay for ChatGPT? Automations on the Codex harness run on your ChatGPT plan, so your credit goes further.</small>
        </span>
        {action}
      </div>
      {state === "connecting" ? (
        <div className="onboardingCodex__connect automationModel">
          <AutomationSubscriptionConnect onConnected={async () => setState("connected")} />
        </div>
      ) : null}
    </section>
  );
}

function OpenAiMark() {
  return (
    <svg aria-hidden="true" fill="currentColor" height="20" viewBox="0 0 24 24" width="20">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073ZM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494ZM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646ZM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872v.024Zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667Zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66v.018ZM8.306 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681l-.005 6.722Zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5-.005-2.999Z" />
    </svg>
  );
}
