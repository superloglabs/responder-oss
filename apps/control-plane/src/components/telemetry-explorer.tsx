import { CaretDownIcon, CaretRightIcon, CheckIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { IconButton, SegmentedControl } from "../design-system";
import { maxOpenFacets, telemetryRanges, type ExplorerFilter, type FacetCount, type TelemetryRange } from "../telemetry-api";
import { useTelemetryQuery } from "../use-telemetry-query";
import { ListSkeleton } from "./screen-skeletons";
import "./telemetry-explorer.css";

export function ExplorerTimeControls({
  live,
  onLiveChange,
  onRangeChange,
  range,
}: {
  live: boolean;
  onLiveChange: (live: boolean) => void;
  onRangeChange: (range: TelemetryRange) => void;
  range: TelemetryRange;
}) {
  return (
    <div className="explorerTime">
      <button
        aria-pressed={live}
        className="explorerLive"
        onClick={() => onLiveChange(!live)}
        title={live ? "Reloading every 10 seconds" : "Reload every 10 seconds"}
        type="button"
      >
        <span aria-hidden="true" />Live
      </button>
      <SegmentedControl aria-label="Time range" onChange={onRangeChange} options={telemetryRanges} value={range} />
    </div>
  );
}

export interface FilterChip {
  id: string;
  label: string;
  onRemove: () => void;
  value: string;
}

// Active filters as removable chips, and a field for adding more. `onSubmit`
// returns whether it used the text, which then clears.
export function ExplorerFilterBar({
  chips,
  initialText = "",
  label,
  onSubmit,
  placeholder,
}: {
  chips: FilterChip[];
  initialText?: string;
  label: string;
  onSubmit: (text: string) => boolean;
  placeholder: string;
}) {
  const [text, setText] = useState(initialText);
  const [syncedText, setSyncedText] = useState(initialText);
  if (initialText !== syncedText) {
    setSyncedText(initialText);
    setText(initialText);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (onSubmit(text.trim())) setText("");
  }
  return (
    <form className="explorerFilterBar" onSubmit={submit} role="search">
      <MagnifyingGlassIcon aria-hidden="true" size={14} />
      {chips.map((chip) => (
        <span className="explorerFilterBar__chip" key={chip.id}>
          <span>{chip.label}:</span>
          {chip.value || "(empty)"}
          <button aria-label={`Remove ${chip.label} ${chip.value}`} onClick={chip.onRemove} type="button">
            <XIcon size={11} />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        maxLength={500}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Backspace in an empty field removes the last chip.
          if (event.key === "Backspace" && !text && chips.length) chips.at(-1)!.onRemove();
        }}
        placeholder={placeholder}
        type="search"
        value={text}
      />
    </form>
  );
}

export interface FacetOption {
  count?: number;
  label: string;
  value: string;
}

// A filter group in the explorer sidebar. Checked values are listed even when
// the window has none of them.
export function ExplorerFacet({
  error,
  loading,
  onCollapse,
  onToggle,
  options,
  selected,
  title,
  tooltip,
}: {
  error?: string | null;
  loading: boolean;
  // Closes a facet that the sidebar lists as a key.
  onCollapse?: () => void;
  onToggle: (value: string) => void;
  options: FacetOption[];
  selected: string[];
  title: string;
  tooltip?: string;
}) {
  const listed: FacetOption[] = [
    ...options,
    ...selected.filter((value) => !options.some((option) => option.value === value)).map((value) => ({ label: value, value })),
  ];
  return (
    <fieldset className="explorerFacet">
      <legend title={tooltip}>
        {onCollapse ? (
          <button aria-expanded="true" className="explorerFacet__toggle" onClick={onCollapse} type="button">
            <CaretDownIcon aria-hidden="true" size={10} weight="bold" />
            <span>{title}</span>
          </button>
        ) : (
          <span>{title}</span>
        )}
      </legend>
      {listed.length === 0 ? (
        error ? (
          <p className="explorerFacet__empty">Values did not load</p>
        ) : loading ? (
          <ListSkeleton rows={3} />
        ) : (
          <p className="explorerFacet__empty">None in this window</p>
        )
      ) : (
        listed.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <label className="explorerFacet__option" key={option.value}>
              <input checked={checked} onChange={() => onToggle(option.value)} type="checkbox" />
              <span aria-hidden="true" className="explorerFacet__box">{checked ? <CheckIcon size={10} weight="bold" /> : null}</span>
              <span className="explorerFacet__label" title={option.label}>{option.label}</span>
              {option.count !== undefined ? (
                <span className="explorerFacet__count">
                  {option.count >= 10_000
                    ? option.count.toLocaleString(undefined, { maximumFractionDigits: 1, notation: "compact" }).toLowerCase()
                    : option.count.toLocaleString()}
                </span>
              ) : null}
            </label>
          );
        })
      )}
    </fieldset>
  );
}

// One open attribute facet, which loads its own values.
function AttributeFacet({
  dataKey,
  facetKey,
  filters,
  live,
  load,
  onCollapse,
  onFiltersChange,
  title,
}: {
  dataKey: string;
  facetKey: string;
  filters: ExplorerFilter[];
  live: boolean;
  load: (key: string) => Promise<FacetCount[]>;
  onCollapse: () => void;
  onFiltersChange: (filters: ExplorerFilter[]) => void;
  title: string;
}) {
  const values = useTelemetryQuery(`${dataKey}#${facetKey}`, () => load(facetKey), live);
  return (
    <ExplorerFacet
      error={values.error}
      loading={!values.data}
      onCollapse={onCollapse}
      onToggle={(value) => {
        const existing = filters.find((filter) => filter.key === facetKey && filter.op === "eq" && filter.value === value);
        // One value per key: attribute filters on a key must all match.
        onFiltersChange(existing
          ? filters.filter((filter) => filter !== existing)
          : [...filters.filter((filter) => filter.key !== facetKey), { key: facetKey, op: "eq", value }]);
      }}
      options={(values.data ?? []).filter((item) => item.group).map((item) => ({ count: item.value, label: item.group, value: item.group }))}
      selected={filters.filter((filter) => filter.key === facetKey && filter.op === "eq").map((filter) => filter.value)}
      title={title}
      tooltip={facetKey}
    />
  );
}

// Every attribute key in the window, grouped by scope. A key opens into a
// facet with its values; keys that are open or filtered on stay listed even
// when the window no longer has them.
export function AttributeFacets({
  dataKey,
  filters,
  keys,
  live = false,
  load,
  onFiltersChange,
  onOpenChange,
  open,
  scopes,
}: {
  // Changes whenever the explorer's query does.
  dataKey: string;
  filters: ExplorerFilter[];
  keys: string[] | null;
  live?: boolean;
  load: (key: string) => Promise<FacetCount[]>;
  onFiltersChange: (filters: ExplorerFilter[]) => void;
  onOpenChange: (open: string[]) => void;
  open: string[];
  scopes: Array<{ label: string; prefix: string }>;
}) {
  const [search, setSearch] = useState("");
  if (keys === null) return <ListSkeleton rows={4} />;
  const inScope = (key: string) => scopes.some((scope) => key.startsWith(scope.prefix));
  const extra = [...open, ...filters.map((filter) => filter.key)].filter((key) => inScope(key) && !keys.includes(key));
  const needle = search.trim().toLowerCase();
  const listed = [...new Set([...extra, ...keys])].filter((key) => !needle || key.toLowerCase().includes(needle));
  if (keys.length === 0 && extra.length === 0) return null;
  return (
    <div className="explorerKeyFacets">
      <label className="explorerKeyFacets__search">
        <MagnifyingGlassIcon aria-hidden="true" size={12} />
        <input
          aria-label="Search attributes"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search attributes"
          type="search"
          value={search}
        />
      </label>
      {scopes.map((scope) => {
        const scoped = listed.filter((key) => key.startsWith(scope.prefix));
        if (scoped.length === 0) return null;
        return (
          <section aria-label={scope.label} className="explorerKeyFacets__group" key={scope.prefix}>
            <h3>{scope.label}</h3>
            {scoped.map((key) => {
              const title = key.slice(scope.prefix.length);
              if (open.includes(key)) {
                return (
                  <AttributeFacet
                    dataKey={dataKey}
                    facetKey={key}
                    filters={filters}
                    key={key}
                    live={live}
                    load={load}
                    onCollapse={() => onOpenChange(open.filter((item) => item !== key))}
                    onFiltersChange={onFiltersChange}
                    title={title}
                  />
                );
              }
              const active = filters.filter((filter) => filter.key === key).length;
              return (
                <button
                  aria-expanded="false"
                  className="explorerAttribute"
                  key={key}
                  onClick={() => onOpenChange([...open, key].slice(-maxOpenFacets))}
                  title={key}
                  type="button"
                >
                  <CaretRightIcon aria-hidden="true" size={10} weight="bold" />
                  <span>{title}</span>
                  {active ? <span className="explorerAttribute__active">{active}</span> : null}
                </button>
              );
            })}
          </section>
        );
      })}
      {listed.length === 0 ? <p className="explorerFacet__empty">No matching attributes</p> : null}
    </div>
  );
}

// A full-height panel over the right of the page. Escape closes it.
export function ExplorerDrawer({
  children,
  header,
  label,
  onClose,
  wide = false,
}: {
  children: ReactNode;
  header: ReactNode;
  label: string;
  onClose: () => void;
  wide?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) close.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, [label]);
  return (
    <aside
      aria-label={label}
      className={wide ? "explorerDrawer explorerDrawer--wide" : "explorerDrawer"}
      ref={panel}
      tabIndex={-1}
    >
      <header className="explorerDrawer__header">
        {header}
        <IconButton aria-label={`Close ${label.toLowerCase()}`} onClick={onClose} size="small" variant="ghost">
          <XIcon size={14} />
        </IconButton>
      </header>
      <div className="explorerDrawer__body">{children}</div>
    </aside>
  );
}

export interface AttributeScope {
  label: string;
  // The filter key prefix for this scope, such as "log." or "resource.".
  prefix: string;
  values: Record<string, string>;
}

// Key and value rows for a log or span, by scope. Each row can add a filter
// on its value, exclude it, or copy it.
export function AttributeTable({
  leading = [],
  onFilter,
  scopes,
}: {
  // Rows shown first under "All", such as IDs that link elsewhere.
  leading?: Array<{ key: string; value: ReactNode }>;
  onFilter?: (key: string, op: "eq" | "neq", value: string) => void;
  scopes: AttributeScope[];
}) {
  const [scope, setScope] = useState("all");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const rows = scopes
    .filter((item) => scope === "all" || item.prefix === scope)
    .flatMap((item) =>
      Object.entries(item.values)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ filterKey: `${item.prefix}${key}`, key, value })),
    )
    .filter((row) => !search || row.key.toLowerCase().includes(search.toLowerCase()));
  const leadingRows = scope === "all" ? leading.filter((row) => !search || row.key.includes(search.toLowerCase())) : [];
  const total = scopes.reduce((sum, item) => sum + Object.keys(item.values).length, 0);

  function copy(id: string, value: string) {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1_500);
    });
  }

  return (
    <section className="explorerAttributes">
      <div className="explorerAttributes__toolbar">
        <div aria-label="Attribute scope" className="explorerPills" role="group">
          {[{ label: "All attributes", prefix: "all", values: {} as Record<string, string> }, ...scopes].map((item) => (
            <button
              aria-pressed={scope === item.prefix}
              key={item.prefix}
              onClick={() => setScope(item.prefix)}
              type="button"
            >
              {item.label}
              <span>{item.prefix === "all" ? total + leading.length : Object.keys(item.values).length}</span>
            </button>
          ))}
        </div>
        <label className="explorerAttributes__search">
          <MagnifyingGlassIcon aria-hidden="true" size={12} />
          <input
            aria-label="Filter attribute keys"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter keys"
            type="search"
            value={search}
          />
        </label>
      </div>
      <div className="explorerTable">
        <div className="explorerTable__header explorerAttributes__row">
          <span>Key</span>
          <span>Value</span>
        </div>
        <div className="explorerTable__body">
          {leadingRows.length + rows.length === 0 ? (
            <p className="explorerTable__empty">No attributes{search ? " match" : ""}.</p>
          ) : null}
          {leadingRows.map((row) => (
            <div className="explorerAttributes__row" key={`leading-${row.key}`}>
              <span className="explorerAttributes__key">{row.key}</span>
              <span className="explorerAttributes__value">{row.value}</span>
            </div>
          ))}
          {rows.map((row) => (
            <div className="explorerAttributes__row" key={row.filterKey}>
              <span className="explorerAttributes__key" title={row.key}>{row.key}</span>
              <span className="explorerAttributes__value">
                <span title={row.value}>{row.value === "" ? <em>(empty)</em> : row.value}</span>
                <span className="explorerAttributes__actions">
                  {onFilter ? (
                    <>
                      <button onClick={() => onFilter(row.filterKey, "eq", row.value)} type="button">Filter</button>
                      <button onClick={() => onFilter(row.filterKey, "neq", row.value)} type="button">Exclude</button>
                    </>
                  ) : null}
                  <button onClick={() => copy(row.filterKey, row.value)} type="button">
                    {copied === row.filterKey ? "Copied" : "Copy"}
                  </button>
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
