import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Button, IconButton, SelectField, TextField } from "../design-system";
import "./attribute-filters.css";

export interface AttributeFilter {
  key: string;
  op?: "eq" | "neq" | "not_contains";
  value: string;
}

const operators = [
  { label: "is", value: "eq" },
  { label: "is not", value: "neq" },
  { label: "does not contain", value: "not_contains" },
] as const;

// The most filters a widget or alert can have.
const maximumFilters = 50;

// Attribute filters: a key from the project's attributes, a comparison and
// a value. `actions` adds buttons beside "Add filter".
export function AttributeFilters({
  actions,
  filters,
  keys,
  onChange,
}: {
  actions?: ReactNode;
  filters: AttributeFilter[];
  keys: string[];
  onChange: (filters: AttributeFilter[]) => void;
}) {
  const change = (index: number, update: Partial<AttributeFilter>) =>
    onChange(filters.map((filter, at) => (at === index ? { ...filter, ...update } : filter)));
  return (
    <fieldset className="attributeFilters">
      <legend>Filters</legend>
      {filters.map((filter, index) => (
        <div className="attributeFilters__row" key={index}>
          <SelectField
            label="Attribute"
            onChange={(key) => change(index, { key })}
            options={[
              ...(filter.key ? [] : [{ label: "Attribute", value: "" }]),
              ...(filter.key && !keys.includes(filter.key) ? [filter.key] : []).concat(keys).map((key) => ({ label: key, value: key })),
            ]}
            searchable
            value={filter.key}
          />
          <SelectField
            label="Comparison"
            onChange={(op) => change(index, { op: op === "eq" ? undefined : op })}
            options={[...operators]}
            value={filter.op ?? "eq"}
          />
          <TextField label="Value" maxLength={500} onChange={(event) => change(index, { value: event.target.value })} value={filter.value} />
          <IconButton aria-label="Remove filter" onClick={() => onChange(filters.filter((_, at) => at !== index))} size="small" variant="ghost">
            <TrashIcon size={14} />
          </IconButton>
        </div>
      ))}
      {filters.length >= maximumFilters ? (
        <p className="attributeFilters__hint">Up to {maximumFilters} filters.</p>
      ) : (
        <div className="attributeFilters__actions">
          <Button onClick={() => onChange([...filters, { key: "", value: "" }])} size="small" variant="secondary">
            <PlusIcon size={12} />Add filter
          </Button>
          {actions}
        </div>
      )}
    </fieldset>
  );
}
