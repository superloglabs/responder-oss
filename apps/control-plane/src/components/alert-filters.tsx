import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { AttributeFilter } from "./attribute-filters";
import { DashboardDialog } from "./dashboard-dialog";
import { Button, IconButton, SelectField, TextField } from "../design-system";

const operators = [
  { label: "is", value: "eq" },
  { label: "is not", value: "neq" },
  { label: "does not contain", value: "not_contains" },
] as const;
export function AlertFilters({
  filters,
  keys,
  onChange,
}: {
  filters: AttributeFilter[];
  keys: string[];
  onChange: (filters: AttributeFilter[]) => void;
}) {
  const [editing, setEditing] = useState<{ index: number; filter: AttributeFilter } | null>(null);
  return (
    <div className="alertFilterField">
      <span>Search criteria · Match all filters</span>
      <div className="alertFilterField__pills">
        {filters.map((filter, index) => (
          <span className="alertFilter" key={index}>
            <button type="button" onClick={() => setEditing({ index, filter })}>
              {filter.key} <span>{operators.find((op) => op.value === (filter.op ?? "eq"))?.label}</span>{" "}
              <strong>{filter.value}</strong>
            </button>
            <IconButton
              aria-label={`Remove ${filter.key} filter`}
              onClick={() => onChange(filters.filter((_, at) => at !== index))}
              size="small"
              variant="ghost"
            >
              <XIcon size={12} />
            </IconButton>
          </span>
        ))}
        <Button
          disabled={filters.length >= 50}
          onClick={() => setEditing({ index: filters.length, filter: { key: "", value: "" } })}
          size="small"
          variant="ghost"
        >
          <PlusIcon size={14} />
          Add filter
        </Button>
      </div>
      {editing ? (
        <DashboardDialog
          title={editing.index === filters.length ? "Add filter" : "Edit filter"}
          onClose={() => setEditing(null)}
          actions={
            <>
              <Button onClick={() => setEditing(null)} variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={!editing.filter.key || !editing.filter.value.trim()}
                variant="primary"
                onClick={() => {
                  const next = [...filters];
                  next[editing.index] = editing.filter;
                  onChange(next);
                  setEditing(null);
                }}
              >
                Apply filter
              </Button>
            </>
          }
        >
          <SelectField
            label="Attribute"
            searchable
            value={editing.filter.key}
            options={[
              { label: "Choose an attribute", value: "" },
              ...Array.from(new Set([...keys, ...(editing.filter.key ? [editing.filter.key] : [])])).map((key) => ({
                label: key,
                value: key,
              })),
            ]}
            onChange={(key) => setEditing({ ...editing, filter: { ...editing.filter, key } })}
          />
          <SelectField
            label="Comparison"
            value={editing.filter.op ?? "eq"}
            options={[...operators]}
            onChange={(op) => setEditing({ ...editing, filter: { ...editing.filter, op } })}
          />
          <TextField
            label="Value"
            value={editing.filter.value}
            maxLength={500}
            onChange={(event) => setEditing({ ...editing, filter: { ...editing.filter, value: event.target.value } })}
          />
        </DashboardDialog>
      ) : null}
    </div>
  );
}
