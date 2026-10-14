import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
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
  // A key per row that survives removing another row, so an open menu stays
  // with its own filter. Rows added from outside get new keys.
  const [rowKeys, setRowKeys] = useState<number[]>(() => filters.map((_, index) => index));
  if (rowKeys.length !== filters.length) {
    const next = rowKeys.slice(0, filters.length);
    let key = Math.max(-1, ...rowKeys);
    while (next.length < filters.length) next.push((key += 1));
    setRowKeys(next);
  }
  const remove = (index: number) => {
    setRowKeys((keys) => keys.filter((_, at) => at !== index));
    onChange(filters.filter((_, at) => at !== index));
  };
  return (
    <fieldset className="attributeFilters">
      <legend>Filters</legend>
      {filters.map((filter, index) => (
        <div className="attributeFilters__row" key={rowKeys[index] ?? `new-${index}`}>
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
          <IconButton aria-label="Remove filter" onClick={() => remove(index)} size="small" variant="ghost">
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
