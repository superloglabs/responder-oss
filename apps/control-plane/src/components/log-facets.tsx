import {
  CaretDownIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import {
  AttributeFacet,
  ExplorerFacet,
  type FacetOption,
} from "./telemetry-explorer";
import {
  maxOpenFacets,
  type ExplorerFilter,
  type FacetCount,
} from "../telemetry-api";

function FacetGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="logFacets__group" aria-label={title}>
      <button
        className="logFacets__heading"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {title}
        {expanded ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
      </button>
      {expanded ? children : null}
    </section>
  );
}

function PrimaryFacet({
  title,
  options,
  selected,
  loading,
  onToggle,
}: {
  title: string;
  options: FacetOption[];
  selected: string[];
  loading: boolean;
  onToggle: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return expanded ? (
    <ExplorerFacet
      gauges
      loading={loading}
      onCollapse={() => setExpanded(false)}
      onToggle={onToggle}
      options={options}
      selected={selected}
      title={title}
    />
  ) : (
    <button
      className="explorerAttribute"
      type="button"
      aria-expanded={false}
      onClick={() => setExpanded(true)}
    >
      <CaretRightIcon size={10} />
      <span>{title}</span>
      {selected.length ? (
        <span className="explorerAttribute__active">{selected.length}</span>
      ) : null}
    </button>
  );
}

export function LogFacets({
  dataKey,
  keys,
  filters,
  load,
  onFiltersChange,
  onOpenChange,
  open,
  services,
  levels,
}: {
  dataKey: string;
  keys: string[] | null;
  filters: ExplorerFilter[];
  load: (key: string) => Promise<FacetCount[]>;
  onFiltersChange: (filters: ExplorerFilter[]) => void;
  onOpenChange: (open: string[]) => void;
  open: string[];
  services: {
    options: FacetOption[];
    selected: string[];
    loading: boolean;
    onToggle: (value: string) => void;
  };
  levels: {
    options: FacetOption[];
    selected: string[];
    loading: boolean;
    onToggle: (value: string) => void;
  };
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const listed = [
    ...new Set([
      ...(keys ?? []),
      ...open,
      ...filters.map((filter) => filter.key),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const scopes = [
    {
      title: "Resource attributes",
      prefix: "resource.",
      primary: "Service",
      props: services,
    },
    {
      title: "Log attributes",
      prefix: "log.",
      primary: "Level",
      props: levels,
    },
  ];
  const groups = scopes.map((scope) => ({
    ...scope,
    matches: listed.filter(
      (key) =>
        key.startsWith(scope.prefix) && key.toLowerCase().includes(needle),
    ),
    showPrimary: scope.primary.toLowerCase().includes(needle),
  }));
  return (
    <aside className="logFacets" aria-label="Log filters">
      <label className="explorerKeyFacets__search">
        <MagnifyingGlassIcon aria-hidden="true" size={12} />
        <input
          type="search"
          aria-label="Search facets"
          placeholder="Search facets"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div
        className="logFacets__viewport"
        tabIndex={0}
        aria-label="Facet groups"
      >
        <div className="logFacets__content">
          {groups.map((scope) =>
            !scope.showPrimary && !scope.matches.length ? null : (
              <FacetGroup
                key={`${scope.prefix}:${needle ? "search" : "all"}`}
                title={scope.title}
              >
                {scope.showPrimary ? (
                  <PrimaryFacet title={scope.primary} {...scope.props} />
                ) : null}
                {scope.matches.map((key) =>
                  open.includes(key) ? (
                    <AttributeFacet
                      key={key}
                      gauges
                      dataKey={dataKey}
                      facetKey={key}
                      filters={filters}
                      live={false}
                      load={load}
                      onCollapse={() =>
                        onOpenChange(open.filter((item) => item !== key))
                      }
                      onFiltersChange={onFiltersChange}
                      title={key.slice(scope.prefix.length)}
                    />
                  ) : (
                    <button
                      key={key}
                      type="button"
                      aria-expanded={false}
                      className="explorerAttribute"
                      title={key}
                      onClick={() =>
                        onOpenChange([...open, key].slice(-maxOpenFacets))
                      }
                    >
                      <CaretRightIcon size={10} />
                      <span>{key.slice(scope.prefix.length)}</span>
                      {filters.some((filter) => filter.key === key) ? (
                        <span className="explorerAttribute__active">
                          {
                            filters.filter((filter) => filter.key === key)
                              .length
                          }
                        </span>
                      ) : null}
                    </button>
                  ),
                )}
              </FacetGroup>
            ),
          )}
          {keys === null ? (
            <p className="explorerFacet__empty">Loading attributes…</p>
          ) : null}
          {groups.every(
            (scope) => !scope.showPrimary && !scope.matches.length,
          ) ? (
            <p className="explorerFacet__empty">No matching facets</p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
