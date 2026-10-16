import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckIcon,
  ClockIcon,
  GlobeSimpleIcon,
  MagnifyingGlassIcon,
  MagnifyingGlassMinusIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Popover } from "radix-ui";
import { type KeyboardEvent, useRef, useState } from "react";
import {
  calendarDay,
  formatFieldTime,
  isLive,
  maximumRangeMinutes,
  monthName,
  monthWeeks,
  offsetLabel,
  parseFieldTime,
  parseRangeInput,
  previewTitle,
  rangeChoice,
  relativeChoice,
  relativePresets,
  resolveTimeRange,
  rezoneFieldText,
  sameTimeRange,
  shiftTimeRange,
  spanLabel,
  startOfDay,
  triggerText,
  zonedParts,
  zonedTime,
  type DashboardTimeRange,
  type RangeChoice,
} from "../dashboard-time-range";
import "./dashboard-time-picker.css";

const recentKey = "responder.dashboardRecentRanges";

function readRecent(): DashboardTimeRange[] {
  try {
    const stored = JSON.parse(localStorage.getItem(recentKey) ?? "[]") as unknown;
    return Array.isArray(stored) ? (stored as DashboardTimeRange[]).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function rememberRange(range: DashboardTimeRange) {
  try {
    const next = [range, ...readRecent().filter((other) => !sameTimeRange(other, range))].slice(0, 5);
    localStorage.setItem(recentKey, JSON.stringify(next));
  } catch {
    // Recent ranges are a convenience; storage may be unavailable.
  }
}

// "Europe/Paris · UTC+02:00"
function timeZoneLabel(timeZone: string, now: number): string {
  return `${timeZone} · ${offsetLabel(timeZone, now)}`;
}

function Kbd({ children }: { children: string }) {
  return <kbd className="timePickerPanel__kbd">{children}</kbd>;
}

// The control in the dashboard header: step back, the range, step forward,
// and zoom out. Its popover sets the range by preset, typed text, or dates.
export function DashboardTimePicker({
  now,
  onChange,
  onTimeZoneChange,
  onZoomOut,
  range,
  timeZone,
  timeZonePreference,
  zoomed,
}: {
  now: number;
  onChange: (range: DashboardTimeRange) => void;
  onTimeZoneChange: (preference: string) => void;
  onZoomOut: () => void;
  range: DashboardTimeRange;
  timeZone: string;
  // "browser" or a time zone name.
  timeZonePreference: string;
  zoomed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const text = triggerText(range, now, timeZone);
  const live = isLive(range);

  function apply(next: DashboardTimeRange) {
    rememberRange(next);
    onChange(next);
    setOpen(false);
  }

  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Anchor asChild>
        <div className="timePicker" data-open={open || undefined}>
          <button aria-label="Earlier" className="timePicker__step" onClick={() => onChange(shiftTimeRange(range, -1, Date.now()))} title="Move back" type="button">
            <CaretLeftIcon size={12} weight="bold" />
          </button>
          <Popover.Trigger asChild>
            <button aria-label={`Time range: ${text.label}`} className="timePicker__range" type="button">
              <ClockIcon size={14} />
              <span className="timePicker__label">{text.label}</span>
              <span className="timePicker__compact">{text.compact}</span>
              {zoomed ? <span className="timePicker__tag">Zoomed</span> : null}
              {!zoomed && text.detail !== text.label ? <span className="timePicker__detail">{text.detail}</span> : null}
              {open ? <CaretUpIcon size={10} weight="bold" /> : <CaretDownIcon size={10} weight="bold" />}
            </button>
          </Popover.Trigger>
          <button
            aria-label="Later"
            className="timePicker__step"
            disabled={live}
            onClick={() => onChange(shiftTimeRange(range, 1, Date.now()))}
            title={live ? "The range already ends now" : "Move forward"}
            type="button"
          >
            <CaretRightIcon size={12} weight="bold" />
          </button>
          <button
            aria-label="Zoom out"
            className="timePicker__zoom"
            data-zoomed={zoomed || undefined}
            disabled={!zoomed && range.kind === "relative" && range.minutes >= maximumRangeMinutes}
            onClick={onZoomOut}
            title="Zoom out"
            type="button"
          >
            <MagnifyingGlassMinusIcon size={14} />
          </button>
        </div>
      </Popover.Anchor>
      <Popover.Content
        align="end"
        className="timePickerPanel"
        collisionPadding={12}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = contentRef.current?.querySelector("input");
          input?.focus();
          input?.select();
        }}
        ref={contentRef}
        sideOffset={6}
      >
        <TimePickerPanel
          onApply={apply}
          onCancel={() => setOpen(false)}
          onTimeZoneChange={onTimeZoneChange}
          range={range}
          timeZone={timeZone}
          timeZonePreference={timeZonePreference}
        />
      </Popover.Content>
    </Popover.Root>
  );
}

function TimePickerPanel({
  onApply,
  onCancel,
  onTimeZoneChange,
  range,
  timeZone,
  timeZonePreference,
}: {
  onApply: (range: DashboardTimeRange) => void;
  onCancel: () => void;
  onTimeZoneChange: (preference: string) => void;
  range: DashboardTimeRange;
  timeZone: string;
  timeZonePreference: string;
}) {
  const [now] = useState(() => Date.now());
  const initialLabel = triggerText(range, now, timeZone).label;
  const initial = resolveTimeRange(range, now);
  // A live range shows its start to the minute.
  const initialFrom = formatFieldTime(isLive(range) ? Math.floor(initial.since / 60_000) * 60_000 : initial.since, timeZone);
  const initialTo = isLive(range) ? "now" : formatFieldTime(initial.until, timeZone);
  const [text, setText] = useState(initialLabel);
  // Picking dates shows the picked range in the text box until someone types.
  const [edited, setEdited] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [fromText, setFromText] = useState(initialFrom);
  const [toText, setToText] = useState(initialTo);
  const [focusedField, setFocusedField] = useState<"from" | "to" | null>(null);
  // The zone the From and To text is written in. Choosing another zone
  // rewrites the text so it keeps naming the same instants.
  const [fieldZone, setFieldZone] = useState(timeZone);
  if (fieldZone !== timeZone) {
    setFieldZone(timeZone);
    setFromText(rezoneFieldText(fromText, fieldZone, timeZone));
    setToText(rezoneFieldText(toText, fieldZone, timeZone));
  }
  const [pickingEnd, setPickingEnd] = useState(false);
  const [showTimeZones, setShowTimeZones] = useState(false);
  const shown = zonedParts(isLive(range) ? now : initial.until, timeZone);
  const [month, setMonth] = useState({ month: shown.month, year: shown.year });
  const [recent] = useState(readRecent);

  const typing = edited && text.trim() !== "" && text !== initialLabel;
  const parsed = typing ? parseRangeInput(text, now, timeZone) : { kind: "empty" as const };
  const choices: RangeChoice[] = (() => {
    if (parsed.kind === "matches") {
      const recentChoices = recent
        .filter((other) => !parsed.matches.some((match) => sameTimeRange(match.range, other)))
        .slice(0, 3)
        .map((other) => rangeChoice(other, now, timeZone));
      return [...parsed.matches, ...recentChoices];
    }
    if (parsed.kind === "phrase") return [parsed.primary, ...parsed.others];
    if (parsed.kind === "invalid") return parsed.suggestions;
    return [];
  })();
  const active = Math.min(highlight, Math.max(0, choices.length - 1));

  // The window the From and To fields describe, or why it cannot be applied.
  const fromTime = parseFieldTime(fromText, timeZone);
  const toLive = toText.trim().toLowerCase() === "now";
  const toTime = toLive ? null : parseFieldTime(toText, timeZone);
  const fieldsChanged = fromText !== initialFrom || toText !== initialTo;
  const draft: { error: string } | { range: DashboardTimeRange } = (() => {
    if (fromTime === null) return { error: "Write From as 2026-10-14 13:00:00." };
    if (!toLive && toTime === null) return { error: "Write To as 2026-10-14 14:00:00, or now." };
    const end = toTime ?? now;
    if (fromTime >= end) return { error: "From must be before To." };
    if (end - fromTime > maximumRangeMinutes * 60_000) return { error: "Ranges can be up to 30 days." };
    return { range: { from: fromTime, kind: "absolute", to: toTime } };
  })();

  function applyFields() {
    if (!fieldsChanged) return onApply(range);
    if ("range" in draft) onApply(draft.range);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (choices.length === 0) return;
      event.preventDefault();
      setHighlight((active + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!typing) applyFields();
      else if (choices[active]) onApply(choices[active].range);
    }
  }

  function pickDay(day: number) {
    const { from: start, to: end } = calendarDay({ day, month: month.month, year: month.year }, now, timeZone);
    const endText = end === null ? "now" : formatFieldTime(end, timeZone);
    const first = pickingEnd ? fromTime : null;
    if (first === null || start < startOfDay(first, timeZone)) {
      setFromText(formatFieldTime(start, timeZone));
      setToText(endText);
      setPickingEnd(true);
      setFocusedField("to");
    } else {
      setToText(endText);
      setPickingEnd(false);
      setFocusedField(null);
    }
    setText(initialLabel);
    setEdited(false);
  }

  const draftRange = "range" in draft ? resolveTimeRange(draft.range, now) : null;
  const headerHint = typing ? null : fieldsChanged && draftRange ? spanLabel(draftRange.until - draftRange.since) : null;
  const inputValue = !edited && fieldsChanged && "range" in draft ? rangeChoice(draft.range, now, timeZone).label : text;

  return (
    <div className="timePickerPanel__inner">
      <div className={`timePickerPanel__header${parsed.kind === "invalid" ? " timePickerPanel__header--invalid" : ""}`}>
        {parsed.kind === "invalid" ? <WarningCircleIcon size={14} /> : <ClockIcon size={14} />}
        <input
          aria-label="Time range"
          autoComplete="off"
          className="timePickerPanel__input"
          onChange={(event) => {
            setText(event.target.value);
            setEdited(true);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          value={inputValue}
        />
        {typing ? (
          <span className="timePickerPanel__hint"><Kbd>esc</Kbd>to close</span>
        ) : headerHint ? (
          <span className="timePickerPanel__hint">{headerHint}</span>
        ) : (
          <span className="timePickerPanel__hint">Type "3h", "yesterday", or "14:00 to 15:30"</span>
        )}
      </div>

      {typing ? (
        <TypedResults active={active} choices={choices} now={now} onApply={onApply} onHighlight={setHighlight} parsed={parsed} timeZone={timeZone} />
      ) : (
        <div className="timePickerPanel__columns">
          <div className="timePickerPanel__presets">
            <p className="timePickerPanel__section">Relative</p>
            {relativePresets.map((minutes) => {
              const selected = !fieldsChanged && range.kind === "relative" && range.minutes === minutes;
              return (
                <button
                  aria-pressed={selected}
                  className="timePickerPanel__preset"
                  key={minutes}
                  onClick={() => onApply({ kind: "relative", minutes })}
                  type="button"
                >
                  {relativeChoice(minutes, now, timeZone).label}
                  {selected ? <CheckIcon size={12} weight="bold" /> : null}
                </button>
              );
            })}
            <span className="timePickerPanel__rule" />
            <button
              className="timePickerPanel__preset"
              onClick={() => onApply({ from: startOfDay(now, timeZone), kind: "absolute", to: null })}
              type="button"
            >
              Today so far
            </button>
            <button
              className="timePickerPanel__preset"
              onClick={() => onApply({ from: startOfDay(now, timeZone, -1), kind: "absolute", to: startOfDay(now, timeZone) })}
              type="button"
            >
              Yesterday
            </button>
          </div>
          <div className="timePickerPanel__absolute">
            <p className="timePickerPanel__section">Absolute</p>
            <div className="timePickerPanel__fields">
              <label className="timePickerPanel__field">
                <span>From</span>
                <input
                  className="timePickerPanel__fieldInput"
                  data-focused={focusedField === "from" || undefined}
                  onBlur={() => setFocusedField(null)}
                  onChange={(event) => { setFromText(event.target.value); setPickingEnd(false); }}
                  onFocus={() => setFocusedField("from")}
                  onKeyDown={(event) => { if (event.key === "Enter") applyFields(); }}
                  spellCheck={false}
                  value={fromText}
                />
              </label>
              <label className="timePickerPanel__field">
                <span>To</span>
                <span className="timePickerPanel__fieldWrap">
                  <input
                    className="timePickerPanel__fieldInput"
                    data-focused={focusedField === "to" || undefined}
                    onBlur={() => setFocusedField(null)}
                    onChange={(event) => { setToText(event.target.value); setPickingEnd(false); }}
                    onFocus={() => setFocusedField("to")}
                    onKeyDown={(event) => { if (event.key === "Enter") applyFields(); }}
                    spellCheck={false}
                    value={toText}
                  />
                  {toLive ? <span className="timePickerPanel__live"><span aria-hidden="true" />Live</span> : null}
                </span>
              </label>
            </div>
            {fieldsChanged && "error" in draft ? <p className="timePickerPanel__fieldError" role="alert">{draft.error}</p> : null}
            <Calendar
              from={fromTime}
              month={month}
              now={now}
              onMonth={setMonth}
              onPick={pickDay}
              timeZone={timeZone}
              to={toLive ? now : toTime}
            />
          </div>
        </div>
      )}

      <div className="timePickerPanel__footer">
        {typing ? (
          <>
            <span className="timePickerPanel__keys">
              <Kbd>↑</Kbd><Kbd>↓</Kbd><span>move</span><Kbd>↵</Kbd><span>apply</span>
            </span>
            <span className="timePickerPanel__spacer" />
            <span className="timePickerPanel__zone">{timeZoneLabel(timeZone, now)}</span>
            <button
              className="timePickerPanel__apply"
              disabled={!choices[active] || parsed.kind === "invalid"}
              onClick={() => { if (choices[active]) onApply(choices[active].range); }}
              type="button"
            >
              Apply range
            </button>
          </>
        ) : (
          <>
            <button
              aria-expanded={showTimeZones}
              className="timePickerPanel__zoneButton"
              onClick={() => setShowTimeZones((current) => !current)}
              type="button"
            >
              <GlobeSimpleIcon size={13} />
              {timeZoneLabel(timeZone, now)}
              <CaretDownIcon size={10} weight="bold" />
            </button>
            <span className="timePickerPanel__spacer" />
            <button className="timePickerPanel__cancel" onClick={onCancel} type="button">Cancel</button>
            <button className="timePickerPanel__apply" disabled={fieldsChanged && "error" in draft} onClick={applyFields} type="button">
              Apply range
            </button>
          </>
        )}
        {showTimeZones && !typing ? (
          <TimeZoneMenu
            now={now}
            onChoose={(preference) => {
              onTimeZoneChange(preference);
              setShowTimeZones(false);
            }}
            preference={timeZonePreference}
          />
        ) : null}
      </div>
    </div>
  );
}

function ChoiceRow({
  choice,
  highlighted,
  onApply,
  onHover,
}: {
  choice: RangeChoice;
  highlighted: boolean;
  onApply: (range: DashboardTimeRange) => void;
  onHover: () => void;
}) {
  return (
    <button
      className="timePickerPanel__choice"
      data-highlighted={highlighted || undefined}
      onClick={() => onApply(choice.range)}
      onMouseEnter={onHover}
      type="button"
    >
      <span className="timePickerPanel__choiceLabel">{choice.label}</span>
      <span className="timePickerPanel__choiceDetail">{choice.detail}</span>
      <span className="timePickerPanel__choiceKey">{highlighted ? <Kbd>↵</Kbd> : null}</span>
    </button>
  );
}

// Where a window sits in its day, for a window within one day.
function DayBar({ range, timeZone }: { range: DashboardTimeRange; timeZone: string }) {
  if (range.kind !== "absolute" || range.to === null) return null;
  const day = startOfDay(range.from, timeZone);
  const next = startOfDay(range.from, timeZone, 1);
  if (range.to > next) return null;
  const length = next - day;
  return (
    <div className="timePickerPanel__dayBar">
      <div className="timePickerPanel__dayTrack">
        <span
          style={{
            left: `${((range.from - day) / length) * 100}%`,
            width: `max(3px, ${((range.to - range.from) / length) * 100}%)`,
          }}
        />
      </div>
      <div className="timePickerPanel__dayTicks">
        <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
      </div>
    </div>
  );
}

function TypedResults({
  active,
  choices,
  now,
  onApply,
  onHighlight,
  parsed,
  timeZone,
}: {
  active: number;
  choices: RangeChoice[];
  now: number;
  onApply: (range: DashboardTimeRange) => void;
  onHighlight: (index: number) => void;
  parsed: ReturnType<typeof parseRangeInput>;
  timeZone: string;
}) {
  const row = (choice: RangeChoice, index: number) => (
    <ChoiceRow
      choice={choice}
      highlighted={index === active}
      key={`${choice.label}-${index}`}
      onApply={onApply}
      onHover={() => onHighlight(index)}
    />
  );

  if (parsed.kind === "matches") {
    const recentRows = choices.slice(parsed.matches.length);
    return (
      <div className="timePickerPanel__results">
        <p className="timePickerPanel__section">Matches</p>
        {parsed.matches.map((choice, index) => row(choice, index))}
        {recentRows.length > 0 ? (
          <>
            <p className="timePickerPanel__section">Recent</p>
            {recentRows.map((choice, index) => row(choice, parsed.matches.length + index))}
          </>
        ) : null}
      </div>
    );
  }

  if (parsed.kind === "phrase") {
    const { primary } = parsed;
    const { since, until } = resolveTimeRange(primary.range, now);
    return (
      <>
        <div className="timePickerPanel__preview">
          <button
            className="timePickerPanel__interpreted"
            data-highlighted={active === 0 || undefined}
            onClick={() => onApply(primary.range)}
            onMouseEnter={() => onHighlight(0)}
            type="button"
          >
            <span className="timePickerPanel__interpretedTop">
              <span>
                <span className="timePickerPanel__interpretedLabel">Interpreted as</span>
                <span className="timePickerPanel__interpretedTitle">{previewTitle(primary.range, now, timeZone)}</span>
              </span>
              <span className="timePickerPanel__interpretedSpan">
                {isLive(primary.range) ? `${spanLabel(until - since)} until now` : spanLabel(until - since)}
                <Kbd>↵</Kbd>
              </span>
            </span>
            <DayBar range={primary.range} timeZone={timeZone} />
          </button>
        </div>
        {parsed.others.length > 0 ? (
          <div className="timePickerPanel__results">
            <p className="timePickerPanel__section">Also matches</p>
            {parsed.others.map((choice, index) => row(choice, index + 1))}
          </div>
        ) : null}
      </>
    );
  }

  if (parsed.kind === "invalid") {
    return (
      <>
        <div className="timePickerPanel__problem" role="alert">
          <p><WarningCircleIcon size={14} />{parsed.message}</p>
          <p className="timePickerPanel__problemHint">{parsed.hint}</p>
        </div>
        {choices.length > 0 ? (
          <div className="timePickerPanel__results">
            <p className="timePickerPanel__section">Did you mean</p>
            {choices.map((choice, index) => row(choice, index))}
          </div>
        ) : null}
      </>
    );
  }
  return null;
}

function Calendar({
  from,
  month,
  now,
  onMonth,
  onPick,
  timeZone,
  to,
}: {
  from: number | null;
  month: { month: number; year: number };
  now: number;
  onMonth: (month: { month: number; year: number }) => void;
  onPick: (day: number) => void;
  timeZone: string;
  to: number | null;
}) {
  const today = zonedParts(now, timeZone);
  const atCurrentMonth = month.year === today.year && month.month === today.month;
  const firstDay = from === null ? null : startOfDay(from, timeZone);
  const lastDay = to === null || from === null || to <= from ? firstDay : startOfDay(to - 1, timeZone);
  const step = (delta: number) => {
    const index = month.year * 12 + month.month - 1 + delta;
    onMonth({ month: (index % 12) + 1, year: Math.floor(index / 12) });
  };
  return (
    <div className="timePickerCalendar">
      <div className="timePickerCalendar__header">
        <span>{monthName(month.month)} {month.year}</span>
        <span className="timePickerCalendar__nav">
          <button aria-label="Previous month" onClick={() => step(-1)} type="button"><CaretLeftIcon size={11} weight="bold" /></button>
          <button aria-label="Next month" disabled={atCurrentMonth} onClick={() => step(1)} type="button"><CaretRightIcon size={11} weight="bold" /></button>
        </span>
      </div>
      <div aria-hidden="true" className="timePickerCalendar__weekdays">
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((day) => <span key={day}>{day}</span>)}
      </div>
      {monthWeeks(month.year, month.month).map((week, index) => (
        <div className="timePickerCalendar__week" key={index}>
          {week.map((day, column) => {
            if (day === null) return <span className="timePickerCalendar__day" key={column} />;
            const start = zonedTime({ day, month: month.month, year: month.year }, timeZone);
            const edge = start === firstDay || start === lastDay;
            const between = firstDay !== null && lastDay !== null && start > firstDay && start < lastDay;
            return (
              <span className="timePickerCalendar__day" data-between={between || undefined} key={column}>
                <button
                  aria-label={`${monthName(month.month)} ${day}`}
                  aria-pressed={edge}
                  data-today={start === startOfDay(now, timeZone) || undefined}
                  disabled={start > now}
                  onClick={() => onPick(day)}
                  type="button"
                >
                  {day}
                </button>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function allTimeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  return supported ? supported("timeZone") : [];
}

function TimeZoneMenu({
  now,
  onChoose,
  preference,
}: {
  now: number;
  onChoose: (preference: string) => void;
  preference: string;
}) {
  const [search, setSearch] = useState("");
  const [zones] = useState(allTimeZones);
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const query = search.trim().toLowerCase().replace(/\s+/gu, "_");
  const matching = zones.filter((zone) => zone !== "UTC" && zone.toLowerCase().includes(query)).slice(0, 200);
  const row = (value: string, label: string, detail: string) => (
    <button
      aria-pressed={preference === value}
      className="timeZoneMenu__row"
      key={value}
      onClick={() => onChoose(value)}
      type="button"
    >
      <span className="timeZoneMenu__name">{label}</span>
      <span className="timeZoneMenu__offset">{detail}</span>
      <span className="timeZoneMenu__check">{preference === value ? <CheckIcon size={11} weight="bold" /> : null}</span>
    </button>
  );
  return (
    <div className="timeZoneMenu">
      <label className="timeZoneMenu__search">
        <MagnifyingGlassIcon size={12} />
        <input
          aria-label="Search time zones"
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search time zones"
          value={search}
        />
      </label>
      <div className="timeZoneMenu__list">
        {!query || "browser time".includes(search.trim().toLowerCase()) ? row("browser", "Browser time", timeZoneLabel(browser, now)) : null}
        {!query || "utc".includes(query) ? row("UTC", "UTC", offsetLabel("UTC", now)) : null}
        {matching.length > 0 ? <span className="timeZoneMenu__rule" /> : null}
        {matching.map((zone) => row(zone, zone, offsetLabel(zone, now)))}
      </div>
    </div>
  );
}
