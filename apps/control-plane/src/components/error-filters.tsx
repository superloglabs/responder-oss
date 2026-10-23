import { FunnelSimpleIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "../design-system";
import { errorIssueStatusLabels } from "../error-issues-api";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "./ui/dropdown-menu";

import { filterProperties, type FilterProperty, type ErrorFilters } from "../error-filter-state";
const names = { status: "Status", activity: "Activity", service: "Service", environment: "Environment" };
const activities = { active: "Still happening", inactive: "No longer happening" };

function label(property: FilterProperty, value: string) {
  if (property === "status") return errorIssueStatusLabels[value as keyof typeof errorIssueStatusLabels] ?? value;
  if (property === "activity") return activities[value as keyof typeof activities] ?? value;
  return value;
}

export function ErrorFilterMenu({ filters, services, environments, onChange, compact = false }: {
  filters: ErrorFilters; services: string[]; environments: string[];
  onChange: (property: FilterProperty, values: string[]) => void; compact?: boolean;
}) {
  const options = { status: Object.keys(errorIssueStatusLabels), activity: Object.keys(activities), service: services, environment: environments };
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button aria-label={compact ? "Add filter" : undefined} size="small" variant={compact ? "ghost" : "secondary"}>
      {compact ? <PlusIcon size={14} /> : <><FunnelSimpleIcon size={14} />Filter</>}
    </Button></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="errorFilterMenu">
      <DropdownMenuLabel>Filter by</DropdownMenuLabel>
      {filterProperties.map((property) => {
        const values = [...new Set([...options[property], ...filters[property]])];
        const all = values.length > 0 && values.every((value) => filters[property].includes(value));
        return <DropdownMenuSub key={property}>
          <DropdownMenuSubTrigger>{names[property]}</DropdownMenuSubTrigger>
          <DropdownMenuPortal><DropdownMenuSubContent className="errorFilterMenu">
            <DropdownMenuLabel>{names[property]}</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={all} onCheckedChange={(checked) => onChange(property, checked ? values : [])} onSelect={(event) => event.preventDefault()}>Select all</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {values.map((value) => <DropdownMenuCheckboxItem key={value} checked={all || filters[property].includes(value)} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => {
              const current = filters[property];
              // An empty selection clears this property, so it never hides every issue by accident.
              onChange(property, checked ? [...current, value] : current.filter((item) => item !== value));
            }}>{label(property, value)}</DropdownMenuCheckboxItem>)}
            {values.length === 0 ? <DropdownMenuLabel>No values yet</DropdownMenuLabel> : null}
          </DropdownMenuSubContent></DropdownMenuPortal>
        </DropdownMenuSub>;
      })}
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function ErrorFilterChips({ filters, onChange }: { filters: ErrorFilters; onChange: (property: FilterProperty, values: string[]) => void }) {
  return <>{filterProperties.filter((property) => filters[property].length > 0).map((property) => <span className="errorFilterChip" key={property}>
    {names[property]} <span>is</span> {filters[property].map((value) => label(property, value)).join(" or ")}
    <button aria-label={`Remove ${names[property].toLowerCase()} filter`} onClick={() => onChange(property, [])} type="button"><XIcon size={12} /></button>
  </span>)}</>;
}
