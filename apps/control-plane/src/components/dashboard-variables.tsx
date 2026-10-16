import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Popover } from "radix-ui";
import { useEffect, useState } from "react";
import { Button, Checkbox, IconButton, TextField } from "../design-system";
import { isLive, relativeParam, resolveTimeRange, type DashboardTimeRange } from "../dashboard-time-range";
import {
  fetchAttributeValueCounts,
  selectedValues,
  variableControl,
  variableFilters,
  variableRow,
  variablesFromRows,
  type DashboardVariable,
  type DashboardVariableValue,
  type VariableRow,
  type VariableValues,
} from "../dashboards-api";
import { DashboardDialog } from "./dashboard-dialog";
import "./dashboard-variables.css";

const countFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: "compact" });

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// A typed value applies on Enter or when the field loses focus, so widgets
// reload once rather than on every keystroke.
function FreeVariable({ label, onCommit, value }: { label: string; onCommit: (value: string) => void; value: string }) {
  const [draft, setDraft] = useState(value);
  const [committed, setCommitted] = useState(value);
  if (value !== committed) {
    setCommitted(value);
    setDraft(value);
  }
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <label className="dashboardVariable dashboardVariable--free">
      <span className="dashboardVariable__name">{label}</span>
      <input
        className="dashboardVariable__input"
        maxLength={500}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) commit(); }}
        placeholder="Any value"
        size={Math.max(8, Math.min(28, draft.length + 1))}
        value={draft}
      />
    </label>
  );
}

function VariableMenu({
  filteredBy,
  filters,
  onApply,
  range,
  selected,
  variable,
}: {
  filteredBy: string[];
  filters: Array<{ key: string; value: string; values?: string[] }>;
  onApply: (value: DashboardVariableValue) => void;
  range: DashboardTimeRange;
  selected: string[];
  variable: DashboardVariable;
}) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<string[]>(selected);
  const [loaded, setLoaded] = useState<{ counts: Map<string, number>; error: boolean; values: string[] } | null>(
    variable.attributeKey ? null : { counts: new Map(), error: false, values: [] },
  );
  const filtersKey = JSON.stringify(filters);

  useEffect(() => {
    if (!variable.attributeKey) return;
    let cancelled = false;
    fetchAttributeValueCounts(resolveTimeRange(range, Date.now()), variable.attributeKey, JSON.parse(filtersKey) as typeof filters)
      .then((values) => {
        if (cancelled) return;
        setLoaded({ counts: new Map(values.map((entry) => [entry.value, entry.count])), error: false, values: values.map((entry) => entry.value) });
      })
      .catch(() => { if (!cancelled) setLoaded({ counts: new Map(), error: true, values: [] }); });
    return () => { cancelled = true; };
  }, [filtersKey, range, variable.attributeKey]);

  // Fixed options keep their order; values seen in the data are listed by
  // how often they were seen. A selected value stays listed even when unseen.
  const base = variable.options.length > 0 ? variable.options : (loaded?.values ?? []);
  const all = [...base, ...selected.filter((value) => !base.includes(value))];
  const query = search.trim().toLowerCase();
  const visible = query ? all.filter((value) => value.toLowerCase().includes(query)) : all;
  const typed = search.trim();
  const canUseTyped = variable.options.length === 0 && typed !== "" && !all.includes(typed);
  const counts = loaded?.counts;
  const windowLabel = range.kind === "relative" ? `in last ${relativeParam(range.minutes)}` : isLive(range) ? "since the range start" : "in this range";
  const multi = Boolean(variable.multi);

  function toggle(value: string) {
    if (!multi) return onApply(value);
    setDraft((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]));
  }

  return (
    <>
      <label className="dashboardVariableMenu__search">
        <MagnifyingGlassIcon size={14} />
        <input
          aria-label={`Search ${variable.attributeKey || variable.name}`}
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canUseTyped) toggle(typed);
            else if (visible.length === 1) toggle(visible[0]!);
            else if (multi) onApply(draft);
          }}
          placeholder={`Search ${variable.attributeKey || variable.name}`}
          value={search}
        />
      </label>
      <div className="dashboardVariableMenu__body">
        <div className="dashboardVariableMenu__meta">
          <span>
            {loaded === null
              ? "Loading values…"
              : loaded.error
                ? "Couldn't load values"
                : `${all.length} ${all.length === 1 ? "value" : "values"}${counts && counts.size > 0 ? ` · seen ${windowLabel}` : ""}`}
          </span>
          {multi && visible.length > 0 ? (
            <button onClick={() => setDraft((current) => [...new Set([...current, ...visible])])} type="button">Select all</button>
          ) : null}
        </div>
        <div className="dashboardVariableMenu__list" role={multi ? "group" : "listbox"}>
          {canUseTyped ? (
            <button className="dashboardVariableMenu__row" onClick={() => toggle(typed)} type="button">
              <span className="dashboardVariableMenu__value">Use “{typed}”</span>
            </button>
          ) : null}
          {visible.map((value) => {
            const checked = multi ? draft.includes(value) : selected.includes(value);
            const count = counts?.get(value);
            return (
              <div className="dashboardVariableMenu__row" data-checked={checked || undefined} key={value}>
                <button
                  aria-pressed={checked}
                  className="dashboardVariableMenu__toggle"
                  onClick={() => toggle(value)}
                  role={multi ? undefined : "option"}
                  type="button"
                >
                  {multi ? (
                    <span aria-hidden="true" className="dashboardVariableMenu__box">{checked ? <CheckIcon size={10} weight="bold" /> : null}</span>
                  ) : null}
                  <span className="dashboardVariableMenu__value" title={value}>{value}</span>
                </button>
                {multi ? (
                  <button className="dashboardVariableMenu__only" onClick={() => setDraft([value])} type="button">Only</button>
                ) : null}
                {count !== undefined ? <span className="dashboardVariableMenu__count">{countFormat.format(count)}</span> : null}
                {!multi ? <span className="dashboardVariableMenu__check">{checked ? <CheckIcon size={12} weight="bold" /> : null}</span> : null}
              </div>
            );
          })}
          {loaded && !loaded.error && visible.length === 0 && !canUseTyped ? (
            <p className="dashboardVariableMenu__empty">
              {query ? "No values match." : variable.attributeKey ? "No values in this time range." : "Type a value to add it."}
            </p>
          ) : null}
        </div>
      </div>
      {multi || filteredBy.length > 0 ? (
        <div className="dashboardVariableMenu__footer">
          <span className="dashboardVariableMenu__filtered">{filteredBy.length > 0 ? `Filtered by ${joinNames(filteredBy)}` : ""}</span>
          {multi ? (
            <>
              <button className="dashboardVariableMenu__clear" onClick={() => setDraft([])} type="button">Clear</button>
              <button className="dashboardVariableMenu__apply" onClick={() => onApply(draft)} type="button">Apply</button>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function VariableControl({
  onChange,
  range,
  values,
  variable,
  variables,
}: {
  onChange: (value: DashboardVariableValue) => void;
  range: DashboardTimeRange;
  values: VariableValues;
  variable: DashboardVariable;
  variables: DashboardVariable[];
}) {
  const [open, setOpen] = useState(false);
  const selected = selectedValues(values[variable.name]);
  const label = variable.label || variable.name;
  const { filters, names } = variableFilters(variables, values, variable.name);
  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger asChild>
        <button
          aria-label={`${label}: ${selected.length === 0 ? "all values" : selected.join(", ")}`}
          className="dashboardVariable"
          data-open={open || undefined}
          type="button"
        >
          <span className="dashboardVariable__name">{label}</span>
          <span className="dashboardVariable__selection">
            <span className="dashboardVariable__value" data-all={selected.length === 0 || undefined}>
              {selected[0] ?? (variable.multi ? "All" : "None")}
            </span>
            {selected.length > 1 ? <span className="dashboardVariable__more">+{selected.length - 1}</span> : null}
            <CaretDownIcon size={10} weight="bold" />
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Content align="start" className="dashboardVariableMenu" collisionPadding={12} sideOffset={6}>
        <VariableMenu
          filteredBy={names}
          filters={filters}
          onApply={(value) => {
            onChange(value);
            setOpen(false);
          }}
          range={range}
          selected={selected}
          variable={variable}
        />
      </Popover.Content>
    </Popover.Root>
  );
}

// One control per variable, then a button to add one. A variable with
// options, an attribute, or several values opens a list of values, where
// values can also be typed; any other variable is a text field.
export function DashboardVariableBar({
  onChange,
  range,
  values,
  variables,
}: {
  onChange: (name: string, value: DashboardVariableValue) => void;
  range: DashboardTimeRange;
  values: VariableValues;
  variables: DashboardVariable[];
}) {
  if (variables.length === 0) return null;
  return (
    <div aria-label="Variables" className="dashboardVariables" role="group">
      {variables.map((variable) =>
        variableControl(variable) === "list" ? (
          <VariableControl
            key={variable.name}
            onChange={(value) => onChange(variable.name, value)}
            range={range}
            values={values}
            variable={variable}
            variables={variables}
          />
        ) : (
          <FreeVariable
            key={variable.name}
            label={variable.label || variable.name}
            onCommit={(value) => onChange(variable.name, value)}
            value={selectedValues(values[variable.name]).join(",")}
          />
        ),
      )}
    </div>
  );
}

export function DashboardVariablesEditor({
  onClose,
  onSave,
  variables,
}: {
  onClose: () => void;
  onSave: (variables: DashboardVariable[]) => Promise<void>;
  variables: DashboardVariable[];
}) {
  const [rows, setRows] = useState<VariableRow[]>(() => variables.map(variableRow));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const change = (index: number, update: Partial<VariableRow>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...update } : row)));

  async function save() {
    if (saving) return;
    const result = variablesFromRows(rows);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(result.variables);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the variables");
      setSaving(false);
    }
  }

  return (
    <DashboardDialog
      actions={
        <>
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button loading={saving} onClick={() => void save()} variant="primary">Save variables</Button>
        </>
      }
      onClose={onClose}
      title="Variables"
    >
      <p className="dashboardDialog__hint">
        Use a variable in a widget filter as <code>$name</code>. With an attribute and no options, its values come from
        the data. With neither, the value is typed.
      </p>
      {rows.map((row, index) => (
        <fieldset className="dashboardVariableRow" disabled={saving} key={index}>
          <legend className="dashboardVariableRow__legend">{row.name || "New variable"}</legend>
          <div className="widgetEditor__row">
            <TextField label="Name" maxLength={60} onChange={(event) => change(index, { name: event.target.value })} value={row.name} />
            <TextField label="Label" maxLength={120} onChange={(event) => change(index, { label: event.target.value })} value={row.label} />
          </div>
          <TextField
            hint="The attribute a filter by this variable uses, such as deployment.environment."
            label="Attribute"
            maxLength={200}
            onChange={(event) => change(index, { attributeKey: event.target.value })}
            value={row.attributeKey}
          />
          <TextField
            hint="Separate options with commas."
            label="Options"
            onChange={(event) => change(index, { options: event.target.value })}
            value={row.options}
          />
          <Checkbox
            checked={row.multi}
            description="Widgets match any selected value. Selecting none matches every value."
            label="Allow several values"
            onChange={(event) => change(index, { multi: event.target.checked })}
          />
          <div className="dashboardVariableRow__footer">
            <TextField label="Default" maxLength={500} onChange={(event) => change(index, { defaultValue: event.target.value })} value={row.defaultValue} />
            <IconButton aria-label={`Remove ${row.name || "variable"}`} onClick={() => setRows((current) => current.filter((_, at) => at !== index))} size="small" variant="ghost">
              <TrashIcon size={14} />
            </IconButton>
          </div>
        </fieldset>
      ))}
      <div>
        <Button
          disabled={saving}
          onClick={() => setRows((current) => [...current, { attributeKey: "", defaultValue: "", label: "", multi: false, name: "", options: "" }])}
          size="small"
          variant="secondary"
        >
          <PlusIcon size={12} />Add variable
        </Button>
      </div>
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </DashboardDialog>
  );
}
