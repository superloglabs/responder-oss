import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button, IconButton, SelectField, TextField } from "../design-system";
import { variableRow, variablesFromRows, type DashboardVariable, type VariableRow } from "../dashboards-api";
import { DashboardDialog } from "./dashboard-dialog";

// One control per variable: a list when it has options, a text box otherwise.
export function DashboardVariableBar({
  onChange,
  values,
  variables,
}: {
  onChange: (name: string, value: string) => void;
  values: Record<string, string>;
  variables: DashboardVariable[];
}) {
  if (variables.length === 0) return null;
  return (
    <div aria-label="Variables" className="dashboardVariables" role="group">
      {variables.map((variable) =>
        variable.options.length > 0 ? (
          <SelectField
            className="dashboardVariables__field"
            key={variable.name}
            label={variable.label || variable.name}
            onChange={(value) => onChange(variable.name, value)}
            options={variable.options.map((option) => ({ label: option, value: option }))}
            searchable={variable.options.length > 8}
            value={values[variable.name] ?? ""}
          />
        ) : (
          <TextField
            className="dashboardVariables__field"
            key={variable.name}
            label={variable.label || variable.name}
            maxLength={500}
            onChange={(event) => onChange(variable.name, event.target.value)}
            value={values[variable.name] ?? ""}
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
        Use a variable in a widget filter as <code>$name</code>. Leave the options empty to type the value freely.
      </p>
      {rows.map((row, index) => (
        <fieldset className="dashboardVariableRow" key={index}>
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
          onClick={() => setRows((current) => [...current, { attributeKey: "", defaultValue: "", label: "", name: "", options: "" }])}
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
