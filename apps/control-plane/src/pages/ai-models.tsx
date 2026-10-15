import { CoinsIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  aiPriceSource,
  createAiSpendDashboard,
  deleteAiPriceOverride,
  fetchAiModels,
  formatTokenPrice,
  saveAiPriceOverride,
  type AiModel,
  type AiModels,
  type AiPriceOverride,
} from "../ai-models-api";
import { AppShell } from "../components/app-shell";
import { useOrganizationCapabilities } from "../organization-capabilities";
import { DashboardDialog } from "../components/dashboard-dialog";
import { TelemetryGate } from "../components/telemetry";
import { Alert, Badge, Button, DataTable, SegmentedControl, TextField } from "../design-system";
import { telemetryRanges, type TelemetryRange } from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryAvailable } from "../use-telemetry-available";
import "../components/automation-run-history.css";
import "../components/ai-models.css";

const rangeValues = new Set<string>(telemetryRanges.map((range) => range.value));
const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });

function modelKey(model: AiModel): string {
  return `${model.provider}|${model.model}|${model.tier}`;
}

// The price form's text fields, in USD per million tokens.
type PriceForm = { cacheRead: string; cacheWrite: string; id: string | null; input: string; model: string; output: string; provider: string };

function priceNumber(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() === "" || !Number.isFinite(value) || value < 0 ? null : value;
}

// The models the workspace's applications called, with the price each call is
// charged at. A model without a price is left out of cost until the
// workspace sets one.
export function AiModelsPage() {
  useDocumentTitle("AI models");
  const navigate = useNavigate();
  const telemetry = useTelemetryAvailable();
  const canCreateDashboards = useOrganizationCapabilities().includes("dashboards");
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get("range") ?? "";
  const range: TelemetryRange = rangeValues.has(rangeParam) ? (rangeParam as TelemetryRange) : "7d";
  const [data, setData] = useState<AiModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PriceForm | null>(null);
  const [creating, setCreating] = useState(false);
  const request = useRef(0);

  function setFilter(key: string, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }

  const load = useCallback(async () => {
    if (!telemetry.available) return;
    const generation = ++request.current;
    try {
      const loaded = await fetchAiModels(range);
      if (request.current !== generation) return;
      setData(loaded);
      setError(null);
    } catch (cause) {
      if (request.current !== generation) return;
      setError(cause instanceof Error ? cause.message : "Unable to load models");
    }
  }, [telemetry.available, range]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  async function createDashboard() {
    setCreating(true);
    try {
      const dashboard = await createAiSpendDashboard();
      navigate(`/dashboards/${dashboard.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the dashboard");
      setCreating(false);
    }
  }

  function editPrice(model: AiModel) {
    const override = data?.overrides.find(
      (price) => price.model === model.model && (price.provider === "" || price.provider === model.provider),
    );
    const card = model.price?.card;
    const text = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));
    setEditing({
      cacheRead: text(override ? override.cacheReadMtok : card?.cacheRead),
      cacheWrite: text(override ? override.cacheWriteMtok : card?.cacheWrite),
      id: override?.id ?? null,
      input: text(override ? override.inputMtok : card?.input),
      model: model.model,
      output: text(override ? override.outputMtok : card?.output),
      provider: override?.provider ?? model.provider,
    });
  }

  const models = data?.models ?? [];
  const unpriced = models.filter((model) => !model.price);
  const seen = new Set(models.map((model) => model.model));
  const otherOverrides = (data?.overrides ?? []).filter((override) => !seen.has(override.model));

  return (
    <AppShell active="ai-models" redesigned>
      <header className="workspaceHeading">
        <h1><CoinsIcon aria-hidden="true" size={16} weight="bold" />AI models</h1>
        {models.length > 0 && canCreateDashboards ? (
          <div className="workspaceHeading__actions">
            <Button loading={creating} onClick={() => void createDashboard()} variant="primary">
              Create AI spend dashboard
            </Button>
          </div>
        ) : null}
      </header>
      <TelemetryGate signal="AI models" state={telemetry}>
        <section aria-label="AI models" className="telemetryPage">
          <div className="telemetryPage__toolbar">
            <SegmentedControl
              aria-label="Time range"
              onChange={(value) => setFilter("range", value === "7d" ? "" : value)}
              options={telemetryRanges}
              value={range}
            />
          </div>
          {error ? (
            <div className="automationRuns__message" role="alert">
              <p>{error}</p>
              <button onClick={() => void load()} type="button">Retry</button>
            </div>
          ) : data === null ? (
            <p className="telemetryPage__status">Loading models…</p>
          ) : models.length === 0 ? (
            <section className="emptyState emptyState--list">
              <h2>No model calls in this time range</h2>
              <p>
                Models appear here once an application sends spans with token usage, such as from the OpenTelemetry
                GenAI instrumentations, OpenLLMetry or the Vercel AI SDK.
              </p>
            </section>
          ) : (
            <>
              <p className="aiModels__summary">
                <strong>{models.length} {models.length === 1 ? "model" : "models"}</strong>
                <span>{models.reduce((sum, model) => sum + model.calls, 0).toLocaleString()} calls</span>
                {data.callsWithoutUsage > 0 ? (
                  <span>{data.callsWithoutUsage.toLocaleString()} calls without token counts</span>
                ) : null}
              </p>
              {unpriced.length > 0 ? (
                <Alert title={`${unpriced.length} ${unpriced.length === 1 ? "model has" : "models have"} no price`} tone="warning">
                  Calls to {unpriced.map((model) => model.model || "an unnamed model").join(", ")} are left out of cost.
                  Set a price for each to include them.
                </Alert>
              ) : null}
              <div className="agentListTable telemetryPage__table">
                <DataTable<AiModel>
                  aria-label="AI models"
                  columns={[
                    {
                      header: "Model",
                      key: "model",
                      render: (model) => (
                        <span className="aiModels__name">
                          <span>{model.model || "Unnamed model"}</span>
                          <span className="aiModels__provider">
                            {[model.provider || "Unknown provider", model.tier].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                      ),
                    },
                    {
                      align: "right",
                      header: "Calls",
                      key: "calls",
                      render: (model) => <span className="telemetryPage__number">{model.calls.toLocaleString()}</span>,
                      width: "80px",
                    },
                    {
                      align: "right",
                      header: "Input",
                      key: "input",
                      render: (model) => <span className="telemetryPage__number">{count.format(model.inputTokens)}</span>,
                      width: "80px",
                    },
                    {
                      align: "right",
                      header: "Output",
                      key: "output",
                      render: (model) => <span className="telemetryPage__number">{count.format(model.outputTokens)}</span>,
                      width: "80px",
                    },
                    {
                      align: "right",
                      header: "Per 1M: in · cached · out",
                      key: "price",
                      render: (model) =>
                        model.price ? (
                          <span className="telemetryPage__number">
                            {formatTokenPrice(model.price.card.input)} · {formatTokenPrice(model.price.card.cacheRead)} ·{" "}
                            {formatTokenPrice(model.price.card.output)}
                          </span>
                        ) : (
                          <span className="aiModels__muted">—</span>
                        ),
                      width: "216px",
                    },
                    {
                      header: "Price from",
                      key: "source",
                      render: (model) =>
                        model.price ? (
                          <span className="aiModels__source" title={aiPriceSource(model)}>{aiPriceSource(model)}</span>
                        ) : (
                          <Badge tone="warning">No price</Badge>
                        ),
                      width: "176px",
                    },
                    {
                      align: "right",
                      header: "",
                      key: "actions",
                      render: (model) => (
                        <Button onClick={() => editPrice(model)} size="small" variant="ghost">
                          {model.price?.source === "workspace" ? "Edit price" : "Set price"}
                        </Button>
                      ),
                      width: "104px",
                    },
                  ]}
                  getRowKey={modelKey}
                  rows={models}
                  variant="workspace"
                />
              </div>
              {otherOverrides.length > 0 ? (
                <p className="aiModels__note">
                  Workspace prices for models not called in this range:{" "}
                  {otherOverrides.map((override) => override.model).join(", ")}.
                </p>
              ) : null}
              <p className="aiModels__note">
                Prices come from the genai-prices catalogue and update daily. Calls above a model's long-context
                threshold are charged its long-context prices.
              </p>
            </>
          )}
        </section>
      </TelemetryGate>
      {editing ? (
        <PriceDialog
          form={editing}
          onClose={() => setEditing(null)}
          onRemove={async (id) => {
            await deleteAiPriceOverride(id);
            setEditing(null);
            await load();
          }}
          onSave={async (price) => {
            await saveAiPriceOverride(price, editing.id);
            setEditing(null);
            await load();
          }}
        />
      ) : null}
    </AppShell>
  );
}

function PriceDialog({
  form: initial,
  onClose,
  onRemove,
  onSave,
}: {
  form: PriceForm;
  onClose: () => void;
  onRemove: (id: string) => Promise<void>;
  onSave: (price: AiPriceOverride) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (change: Partial<PriceForm>) => setForm((current) => ({ ...current, ...change }));

  async function save() {
    const input = priceNumber(form.input);
    const output = priceNumber(form.output);
    if (input === null || output === null) {
      setError("Enter input and output prices of zero or more.");
      return;
    }
    if ((form.cacheRead.trim() && priceNumber(form.cacheRead) === null) || (form.cacheWrite.trim() && priceNumber(form.cacheWrite) === null)) {
      setError("Cache prices must be zero or more, or left empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        cacheReadMtok: priceNumber(form.cacheRead),
        cacheWriteMtok: priceNumber(form.cacheWrite),
        inputMtok: input,
        model: form.model,
        outputMtok: output,
        provider: form.provider,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the price");
      setSaving(false);
    }
  }

  return (
    <DashboardDialog
      actions={
        <>
          {initial.id ? (
            <Button
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void onRemove(initial.id!).catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : "Unable to remove the price");
                  setSaving(false);
                });
              }}
              variant="danger"
            >
              Use catalogue price
            </Button>
          ) : null}
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button loading={saving} onClick={() => void save()} variant="primary">Save price</Button>
        </>
      }
      onClose={onClose}
      title={`Price for ${form.model}`}
    >
      <p className="aiModels__dialogText">
        US dollars per million tokens. This price applies to every call to this model in the workspace, including
        past calls. Cached tokens without a price are charged as input.
      </p>
      <div className="aiModels__priceGrid">
        <TextField inputMode="decimal" label="Input" onChange={(event) => update({ input: event.target.value })} value={form.input} />
        <TextField inputMode="decimal" label="Output" onChange={(event) => update({ output: event.target.value })} value={form.output} />
        <TextField
          inputMode="decimal"
          label="Cache read"
          onChange={(event) => update({ cacheRead: event.target.value })}
          value={form.cacheRead}
        />
        <TextField
          inputMode="decimal"
          label="Cache write"
          onChange={(event) => update({ cacheWrite: event.target.value })}
          value={form.cacheWrite}
        />
      </div>
      <TextField
        hint="Leave empty to use this price for the model from any provider."
        label="Provider"
        onChange={(event) => update({ provider: event.target.value })}
        value={form.provider}
      />
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </DashboardDialog>
  );
}
