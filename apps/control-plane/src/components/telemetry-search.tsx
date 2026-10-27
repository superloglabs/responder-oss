import { CaretLeftIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { FacetCount, LogExplorerQuery, TraceSearchQuery } from "../telemetry-api";
import { useTelemetryQuery } from "../use-telemetry-query";
import { searchInputProps } from "./search-input-props";
import { durationMs, fieldLabel, parseSearchDraft, queryWithTokens, searchFields, searchTokens, statusLabels, traceIdPattern, type SearchField, type SearchOperator, type SearchToken } from "./telemetry-search-model";
import "./telemetry-search.css";

type Props = {
  dataKey: string;
  attributeKeys: string[] | null;
  keysError?: string | null;
  onRetryKeys: () => void;
  loadValues: (key: string) => Promise<FacetCount[]>;
} & ({ signal: "logs"; query: LogExplorerQuery; onChange: (query: LogExplorerQuery) => void } | {
  signal: "traces"; query: TraceSearchQuery; onChange: (query: TraceSearchQuery) => void; onOpenTrace: (id: string) => void;
});
type Draft = { field: SearchField | null; op: SearchOperator; text: string; edit: string | null; operators: boolean };
const emptyDraft: Draft = { field: null, op: "=", text: "", edit: null, operators: false };
const operatorLabels: Record<SearchOperator, string> = { "=": "is", "!=": "is not", ">=": "at least", contains: "contains" };
type Suggestion = { id: string; label: string; group?: string; field?: SearchField; op?: SearchOperator; token?: Omit<SearchToken, "id">; trace?: string };
const messageField: SearchField = { key: "message", label: "message", group: "Text search", operators: ["contains"], kind: "message" };

function Highlight({ value, query }: { value: string; query: string }) {
  const i = value.toLowerCase().indexOf(query.toLowerCase());
  return !query || i < 0 ? value : <>{value.slice(0, i)}<mark>{value.slice(i, i + query.length)}</mark>{value.slice(i + query.length)}</>;
}

export function TelemetrySearch(props: Props) {
  const { query, signal } = props;
  const tokens = searchTokens(query);
  const signature = JSON.stringify(tokens);
  const [synced, setSynced] = useState(signature);
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  // Browser history and sidebar updates replace the committed state, including
  // any chip being edited. Never retain an edit against an obsolete query.
  if (signature !== synced) {
    setSynced(signature);
    if (signature !== pendingSignature) { setDraft(emptyDraft); setActive(0); setOpen(false); }
    setPendingSignature(null);
  }
  const fields = searchFields(signal, [...(props.attributeKeys ?? []), ...query.filters.map(f => f.key)]);
  const field = draft.field;
  const needle = draft.text.trim();
  const valueKey = open && field && !field.kind && !draft.operators ? `${props.dataKey}:${field.key}` : null;
  const values = useTelemetryQuery(valueKey, () => props.loadValues(field!.key));

  useEffect(() => {
    const onPointer = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const onShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && target instanceof HTMLElement && !target.isContentEditable && !target.closest("input, textarea, select, [contenteditable=true], [role=textbox], [role=dialog]")) {
        event.preventDefault(); input.current?.focus(); setOpen(true);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onShortcut);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onShortcut); };
  }, []);

  function changeTokens(next: SearchToken[]) {
    if (props.signal === "logs") {
      const updated = queryWithTokens(props.query, next);
      setPendingSignature(JSON.stringify(searchTokens(updated)));
      props.onChange(updated);
    } else {
      const updated = queryWithTokens(props.query, next);
      setPendingSignature(JSON.stringify(searchTokens(updated)));
      props.onChange(updated);
    }
  }
  function dismiss() { setDraft(emptyDraft); setOpen(false); setActive(0); }
  function commit(token: Omit<SearchToken, "id">) {
    const next = tokens.filter(t => t.id !== draft.edit && !(token.key === "message" || token.key === "duration" ? t.key === token.key : t.key === token.key && t.op === token.op && t.value === token.value));
    changeTokens([...next, { ...token, id: "new" }]);
    setAnnouncement(`Applied ${field?.label ?? token.key} ${token.op} ${token.value}`);
    input.current?.focus(); dismiss();
  }
  function selectField(next: SearchField) {
    setDraft({ ...draft, field: next, op: next.operators[0], text: "", operators: false }); setActive(0); setOpen(true); input.current?.focus();
  }
  function editToken(token: SearchToken) {
    const found = token.key === "message" ? messageField : fields.find(f => f.key === token.key);
    if (!found) return;
    setDraft({ field: found, op: token.op, text: token.value, edit: token.id, operators: false });
    setActive(0); setOpen(true); input.current?.focus();
  }
  function changeText(text: string) {
    const parsed = !field ? parseSearchDraft(text, fields) : null;
    setDraft(parsed ? { ...draft, ...parsed, text: parsed.value } : { ...draft, text });
    setActive(0); setOpen(true);
  }

  let options: Suggestion[] = [];
  let validation = "";
  if (!field) {
    options = fields.filter(f => [f.key, f.label, ...(f.aliases ?? [])].some(s => s.toLowerCase().includes(needle.toLowerCase())))
      .map(f => ({ id: f.key, label: f.label, group: f.group, field: f }));
    if (needle) {
      if (traceIdPattern.test(needle)) {
        options.unshift(signal === "traces" ? { id: "trace", label: `Open trace ${needle}`, trace: needle.toLowerCase() } : { id: "trace", label: `trace.id = ${needle}`, token: { key: "field.trace_id", op: "=", value: needle.toLowerCase() } });
      } else {
        options.push({ id: "text", group: "Text search", label: signal === "logs" ? `Search messages for “${needle}”` : `Filter span name “${needle}”`, token: { key: signal === "logs" ? "message" : "operation", op: signal === "logs" ? "contains" : "=", value: needle } });
      }
    }
  } else if (draft.operators) {
    options = field.operators.map(op => ({ id: op, label: `${op}  ${operatorLabels[op]}`, op }));
  } else {
    const available = field.kind === "duration" ? ["100ms", "500ms", "1s", "5s"] : field.kind ? [] : values.isFetching || values.error ? [] : (values.data ?? []).map(v => v.group);
    const label = (v: string) => field.key === "status" ? statusLabels[v] ?? v : v;
    options = [...new Set(available)].filter(v => `${v} ${label(v)}`.toLowerCase().includes(needle.toLowerCase())).map(value => ({ id: `value:${value}`, label: label(value) || "(empty)", token: { key: field.key, op: draft.op, value } }));
    const valid = field.kind === "duration" ? durationMs(needle) !== null : field.kind === "trace" ? traceIdPattern.test(needle) : Boolean(needle);
    if (valid && !options.some(o => o.token?.value.toLowerCase() === needle.toLowerCase())) {
      options.push({ id: "custom", label: field.kind === "message" ? `Search messages for “${needle}”` : `Use “${needle}”`, token: { key: field.key, op: draft.op, value: field.kind === "trace" ? needle.toLowerCase() : needle } });
    }
    if (field.kind === "duration" && !valid && needle) validation = "Use a positive duration up to 60m, such as 500ms, 1s, or 1m.";
    if (field.kind === "trace" && !valid) validation = "Enter a 32-character hexadecimal trace ID.";
  }
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  function choose(option: Suggestion | undefined) {
    if (!option) return;
    if (option.field) selectField(option.field);
    else if (option.op) { setDraft({ ...draft, op: option.op, operators: false }); setActive(0); input.current?.focus(); }
    else if (option.trace && props.signal === "traces") { props.onOpenTrace(option.trace); dismiss(); }
    else if (option.token) commit(option.token);
  }
  useEffect(() => {
    if (open) document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, id]);

  return <div className="telemetrySearch" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <div className="telemetrySearch__bar" role="search" aria-label={signal === "logs" ? "Log search" : "Trace search"}>
      <MagnifyingGlassIcon className="telemetrySearch__icon" aria-hidden="true" size={14} />
      <div className="telemetrySearch__entry">
        {tokens.map(token => {
          const label = fields.find(f => f.key === token.key)?.label ?? fieldLabel(token.key);
          const value = token.key === "status" ? statusLabels[token.value] ?? token.value : token.value;
          return <span className="telemetrySearch__chip" key={token.id} data-editing={draft.edit === token.id}>
            <button type="button" aria-label={`Edit ${label} ${token.op} ${value}`} onClick={() => editToken(token)}><span>{label} {token.op}</span> {value || "(empty)"}</button>
            <button type="button" className="telemetrySearch__remove" aria-label={`Remove ${label} ${value}`} onClick={() => { changeTokens(tokens.filter(t => t.id !== token.id)); input.current?.focus(); dismiss(); }}><XIcon size={11} aria-hidden="true" /></button>
          </span>;
        })}
        <div className="telemetrySearch__composer">
          {field ? <><button type="button" aria-label="Change attribute" onClick={() => { setDraft({ ...draft, field: null, text: "", operators: false }); setActive(0); setOpen(true); input.current?.focus(); }}>{field.label}</button><button type="button" aria-label={`Change operator, ${operatorLabels[draft.op]}`} onClick={() => { setDraft({ ...draft, operators: !draft.operators }); setActive(0); setOpen(true); input.current?.focus(); }}>{draft.op}</button></> : null}
          <input {...searchInputProps} ref={input} role="combobox" aria-label={signal === "logs" ? "Search logs" : "Filter traces"} aria-autocomplete="list" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open && options.length ? `${id}-${activeIndex}` : undefined}
            maxLength={500} spellCheck={false} value={draft.text} placeholder={field ? field.kind === "duration" ? "Enter a duration, e.g. 500ms" : "Search values…" : signal === "logs" ? "Search messages, attributes, or a trace ID…" : "Search span names, attributes, or a trace ID…"}
            onChange={event => changeText(event.target.value)} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
              else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); setActive(!open ? 0 : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(1, options.length)); }
              else if (event.key === "Enter") { event.preventDefault(); if (!open) setOpen(true); else choose(options[activeIndex]); }
              else if (event.key === "Backspace" && !draft.text) { if (field) { setDraft({ ...draft, field: null, operators: false }); setActive(0); } else if (tokens.length) { event.preventDefault(); editToken(tokens.at(-1)!); } }
            }} />
        </div>
      </div>
      {tokens.length || draft.text || field ? <button type="button" className="telemetrySearch__clear" aria-label="Clear search" onClick={() => { changeTokens([]); input.current?.focus(); dismiss(); setAnnouncement("Search cleared"); }}><XIcon size={14} aria-hidden="true" /></button> : <kbd aria-hidden="true">/</kbd>}
    </div>
    {open ? <div className="telemetrySearch__popup">
      {field ? <div className="telemetrySearch__head"><button type="button" aria-label="Back to attributes" onClick={() => { setDraft({ ...draft, field: null, text: "", operators: false }); setActive(0); input.current?.focus(); }}><CaretLeftIcon size={14} /></button><strong>{field.label}</strong><span>{draft.operators ? "Choose an operator" : draft.op === "!=" ? "Exclude a value" : "Choose a value"}</span></div> : null}
      <div id={`${id}-list`} role="listbox" aria-label="Search suggestions" className="telemetrySearch__list">
        {options.map((option, index) => <Fragment key={option.id}>
          {option.group && option.group !== options[index - 1]?.group ? <div className="telemetrySearch__group" role="presentation">{option.group}</div> : null}
          <div id={`${id}-${index}`} role="option" aria-selected={index === activeIndex} className="telemetrySearch__option" onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(option)}><span><Highlight value={option.label} query={needle} /></span><kbd aria-hidden="true">⏎</kbd></div>
        </Fragment>)}
      </div>
      {!field && props.attributeKeys === null ? <p className="telemetrySearch__notice" role="status">{props.keysError ? <>Attributes could not load. <button type="button" onClick={props.onRetryKeys}>Retry</button></> : "Loading attributes…"}</p> : null}
      {valueKey && values.isFetching ? <p className="telemetrySearch__notice" role="status">Loading values…</p> : null}
      {valueKey && values.error && !values.isFetching ? <p className="telemetrySearch__notice" role="status">Values could not load. <button type="button" onClick={values.retry}>Retry</button></p> : null}
      {validation || (!options.length && !(valueKey && (values.isFetching || values.error))) ? <p className="telemetrySearch__notice" role="status">{validation || "No suggested values. Type a value to use it."}</p> : null}
      <div className="telemetrySearch__footer" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd>navigate</span><span><kbd>⏎</kbd>select</span><span><kbd>esc</kbd>close</span></div>
    </div> : null}
    <span className="telemetrySearch__sr" role="status">{announcement}</span>
  </div>;
}
