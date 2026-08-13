import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  size?: "small" | "medium";
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

export function Button({
  children,
  className,
  disabled,
  loading = false,
  size = "medium",
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  return (
    <button
      aria-busy={loading || undefined}
      className={classNames(
        "dsButton",
        `dsButton--${variant}`,
        `dsButton--${size}`,
        className,
      )}
      disabled={disabled || loading}
      type={type}
      {...props}
    >
      {loading ? <span aria-hidden="true" className="dsSpinner" /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string;
  size?: "small" | "medium";
  variant?: "secondary" | "ghost";
}

export function IconButton({
  children,
  className,
  size = "medium",
  type = "button",
  variant = "secondary",
  ...props
}: IconButtonProps) {
  return (
    <button
      className={classNames(
        "dsIconButton",
        `dsIconButton--${size}`,
        `dsIconButton--${variant}`,
        className,
      )}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "compact" | "default" | "spacious";
  surface?: "base" | "raised";
}

export function Panel({
  children,
  className,
  padding = "default",
  surface = "base",
  ...props
}: PanelProps) {
  return (
    <div
      className={classNames(
        "dsPanel",
        `dsPanel--${surface}`,
        `dsPanel--padding-${padding}`,
        surface === "raised" && "shadow-xl",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "circle" | "text";
}

export function Skeleton({
  className,
  variant = "text",
  ...props
}: SkeletonProps) {
  return (
    <span
      className={classNames("dsSkeleton", `dsSkeleton--${variant}`, className)}
      {...props}
      aria-hidden="true"
    />
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "live" | "warning" | "danger" | "info";
}

export function Badge({
  children,
  className,
  tone = "neutral",
  ...props
}: BadgeProps) {
  return (
    <span
      className={classNames("dsBadge", `dsBadge--${tone}`, className)}
      {...props}
    >
      {tone !== "neutral" ? (
        <span aria-hidden="true" className="dsBadge__dot" />
      ) : null}
      {children}
    </span>
  );
}

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  error?: string;
  hint?: string;
  label: string;
}

export function TextField({
  className,
  error,
  hint,
  id,
  label,
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = error
    ? `${inputId}-error`
    : hint
      ? `${inputId}-hint`
      : undefined;

  return (
    <label className={classNames("dsField", className)} htmlFor={inputId}>
      <span className="dsField__label">{label}</span>
      <input
        aria-describedby={descriptionId}
        aria-invalid={error ? true : undefined}
        className="dsField__control"
        id={inputId}
        {...props}
      />
      {error ? (
        <span className="dsField__error" id={descriptionId}>
          {error}
        </span>
      ) : hint ? (
        <span className="dsField__hint" id={descriptionId}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export interface SearchItem {
  id: string;
  keywords?: string;
  label: string;
}

export interface SearchFieldProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  emptyDescription?: string;
  emptyTitle?: string;
  items: Array<SearchItem>;
  label: string;
  maxResults?: number;
  onSelect?: (item: SearchItem) => void;
  onValueChange: (value: string) => void;
  placeholder?: string;
  value: string;
}

export function SearchField({
  className,
  emptyDescription = "Adjust your search to try again",
  emptyTitle = "No results found",
  items,
  label,
  maxResults = 5,
  onSelect,
  onValueChange,
  placeholder = "Search…",
  value,
  ...props
}: SearchFieldProps) {
  const inputId = useId();
  const resultsId = `${inputId}-results`;
  const query = value.trim().toLowerCase();
  const results = (query
    ? items.filter((item) =>
        `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(query),
      )
    : items
  ).slice(0, maxResults);
  const empty = value.length > 2 && results.length === 0;

  return (
    <div className={classNames("dsSearch", className)} {...props}>
      <div className="dsSearch__card shadow-xl">
        <div className="dsSearch__inputRow">
          <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="M21 21l-4.3-4.3" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
          </svg>
          <input
            aria-autocomplete="list"
            aria-controls={resultsId}
            aria-expanded="true"
            aria-label={label}
            id={inputId}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={placeholder}
            role="combobox"
            type="search"
            value={value}
          />
          {value ? (
            <button
              aria-label="Clear search"
              className="dsSearch__clear"
              onClick={() => onValueChange("")}
              type="button"
            >
              <svg aria-hidden="true" fill="none" height="11" viewBox="0 0 24 24" width="11">
                <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
              </svg>
            </button>
          ) : null}
        </div>
        <div className="dsSearch__results" id={resultsId} role="listbox">
          {empty ? (
            <div className="dsSearch__empty">
              <span aria-hidden="true" className="dsSearch__emptyIcon">
                <svg fill="none" height="15" viewBox="0 0 24 24" width="15">
                  <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M21 21l-4.3-4.3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                </svg>
              </span>
              <strong>{emptyTitle}</strong>
              <span>{emptyDescription}</span>
            </div>
          ) : (
            results.map((item) => (
              <button
                aria-selected={value === item.label}
                className="dsSearch__result"
                key={item.id}
                onClick={() => {
                  onValueChange(item.label);
                  onSelect?.(item);
                }}
                role="option"
                type="button"
              >
                {item.label}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export interface SegmentOption<Value extends string> {
  disabled?: boolean;
  label: string;
  value: Value;
}

export interface SegmentedControlProps<Value extends string> {
  "aria-label": string;
  onChange: (value: Value) => void;
  options: Array<SegmentOption<Value>>;
  value: Value;
}

export function SegmentedControl<Value extends string>({
  "aria-label": ariaLabel,
  onChange,
  options,
  value,
}: SegmentedControlProps<Value>) {
  return (
    <div aria-label={ariaLabel} className="dsSegmentedControl" role="radiogroup">
      {options.map((option) => (
        <button
          aria-checked={option.value === value}
          className="dsSegmentedControl__option"
          disabled={option.disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface TextAreaFieldProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
  hint?: string;
  label: string;
}

export function TextAreaField({
  className,
  error,
  hint,
  id,
  label,
  ...props
}: TextAreaFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = error
    ? `${inputId}-error`
    : hint
      ? `${inputId}-hint`
      : undefined;

  return (
    <label className={classNames("dsField", className)} htmlFor={inputId}>
      <span className="dsField__label">{label}</span>
      <textarea
        aria-describedby={descriptionId}
        aria-invalid={error ? true : undefined}
        className="dsField__control dsField__control--textarea"
        id={inputId}
        {...props}
      />
      {error ? (
        <span className="dsField__error" id={descriptionId}>
          {error}
        </span>
      ) : hint ? (
        <span className="dsField__hint" id={descriptionId}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export interface SelectOption<Value extends string> {
  description?: string;
  label: string;
  value: Value;
}

export interface SelectFieldProps<Value extends string> {
  className?: string;
  disabled?: boolean;
  hint?: string;
  label: string;
  name?: string;
  onChange: (value: Value) => void;
  options: Array<SelectOption<Value>>;
  value: Value;
}

export function SelectField<Value extends string>({
  className,
  disabled = false,
  hint,
  label,
  name,
  onChange,
  options,
  value,
}: SelectFieldProps<Value>) {
  const inputId = useId();
  const hintId = hint ? `${inputId}-hint` : undefined;
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value);

  useEffect(() => {
    if (!isOpen) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  return (
    <div className={classNames("dsField", className)} ref={rootRef}>
      <span className="dsField__label" id={`${inputId}-label`}>{label}</span>
      <div className="dsSelect">
        {name ? <input name={name} type="hidden" value={value} /> : null}
        <button
          aria-describedby={hintId}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-labelledby={`${inputId}-label ${inputId}-value`}
          className="dsSelect__trigger"
          disabled={disabled}
          id={inputId}
          onClick={() => setIsOpen((current) => !current)}
          type="button"
        >
          <span id={`${inputId}-value`}>{selectedOption?.label ?? "Select…"}</span>
          <svg aria-hidden="true" fill="none" height="12" viewBox="0 0 12 12" width="12">
            <path d="m3 4.75 3 2.75 3-2.75" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {isOpen ? (
          <div aria-labelledby={`${inputId}-label`} className="dsSelect__popover shadow-xl" role="listbox">
            {options.map((option) => (
              <button
                aria-selected={option.value === value}
                className="dsSelect__option"
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                role="option"
                type="button"
              >
                <span>
                  <strong>{option.label}</strong>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
                {option.value === value ? <span aria-hidden="true" className="dsSelect__check">✓</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {hint ? (
        <span className="dsField__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  description?: string;
  label: string;
}

export function Checkbox({
  className,
  description,
  label,
  ...props
}: CheckboxProps) {
  return (
    <label className={classNames("dsChoice", className)}>
      <input className="dsChoice__input" type="checkbox" {...props} />
      <span aria-hidden="true" className="dsChoice__mark">
        <svg fill="none" height="11" viewBox="0 0 12 12" width="11">
          <path d="m2.5 6 2.25 2.25L9.5 3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="dsChoice__copy">
        <strong>{label}</strong>
        {description ? <span>{description}</span> : null}
      </span>
    </label>
  );
}

export interface RadioProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  description?: string;
  label: string;
}

export function Radio({ className, description, label, ...props }: RadioProps) {
  return (
    <label className={classNames("dsChoice", className)}>
      <input className="dsChoice__input" type="radio" {...props} />
      <span aria-hidden="true" className="dsChoice__mark dsChoice__mark--radio" />
      <span className="dsChoice__copy">
        <strong>{label}</strong>
        {description ? <span>{description}</span> : null}
      </span>
    </label>
  );
}

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "onClick"> {
  checked: boolean;
  description?: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}

export function Switch({
  checked,
  className,
  description,
  disabled,
  label,
  onCheckedChange,
  type = "button",
  ...props
}: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      className={classNames("dsSwitch", className)}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      role="switch"
      type={type}
      {...props}
    >
      <span className="dsSwitch__copy">
        <strong>{label}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      <span aria-hidden="true" className="dsSwitch__track">
        <span />
      </span>
    </button>
  );
}

export interface TabOption<Value extends string> {
  label: string;
  value: Value;
}

export interface TabsProps<Value extends string> {
  "aria-label": string;
  onChange: (value: Value) => void;
  options: Array<TabOption<Value>>;
  value: Value;
}

export function Tabs<Value extends string>({
  "aria-label": ariaLabel,
  onChange,
  options,
  value,
}: TabsProps<Value>) {
  return (
    <div aria-label={ariaLabel} className="dsTabs" role="tablist">
      {options.map((option) => (
        <button
          aria-selected={option.value === value}
          className="dsTabs__tab"
          key={option.value}
          onClick={() => onChange(option.value)}
          role="tab"
          tabIndex={option.value === value ? 0 : -1}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}

export function Alert({
  children,
  className,
  title,
  tone = "neutral",
  ...props
}: AlertProps) {
  return (
    <div
      className={classNames(
        "dsPanel",
        "dsPanel--raised",
        "dsAlert",
        `dsAlert--${tone}`,
        "shadow-xl",
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="dsAlert__indicator" />
      <div>
        <strong>{title}</strong>
        {children ? <div className="dsAlert__body">{children}</div> : null}
      </div>
    </div>
  );
}

export interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  image?: string;
  name: string;
  size?: "small" | "medium" | "large";
}

export function Avatar({
  className,
  image,
  name,
  size = "medium",
  ...props
}: AvatarProps) {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      aria-label={name}
      className={classNames("dsAvatar", `dsAvatar--${size}`, className)}
      role="img"
      {...props}
    >
      {image ? <img alt="" src={image} /> : initials}
    </div>
  );
}

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  action?: ReactNode;
  description: string;
  icon?: ReactNode;
  title: string;
}

export function EmptyState({
  action,
  className,
  description,
  icon,
  title,
  ...props
}: EmptyStateProps) {
  return (
    <div className={classNames("dsEmptyState", className)} {...props}>
      {icon ? <div className="dsEmptyState__icon">{icon}</div> : null}
      <h3>{title}</h3>
      <p>{description}</p>
      {action ? <div className="dsEmptyState__action">{action}</div> : null}
    </div>
  );
}

export interface DataTableColumn<Row> {
  align?: "left" | "right";
  header: string;
  key: string;
  render: (row: Row) => ReactNode;
  width?: string;
}

export interface DataTableFilter<Filter extends string> {
  count: number;
  dot?: string;
  label: string;
  value: Filter;
}

export interface DataTableProps<Row, Filter extends string = string> {
  "aria-label": string;
  activeFilter?: Filter;
  columns: Array<DataTableColumn<Row>>;
  emptyMessage?: string;
  filters?: Array<DataTableFilter<Filter>>;
  getRowGroup?: (row: Row) => string;
  getRowKey: (row: Row) => string | number;
  onFilterChange?: (value: Filter) => void;
  rows: Array<Row>;
}

function groupDataTableRows<Row>(
  rows: Array<Row>,
  getRowGroup: (row: Row) => string,
) {
  return rows.reduce<Array<{ label: string; rows: Array<Row> }>>(
    (groups, row) => {
      const label = getRowGroup(row);
      const currentGroup = groups.at(-1);

      if (currentGroup?.label === label) {
        currentGroup.rows.push(row);
      } else {
        groups.push({ label, rows: [row] });
      }

      return groups;
    },
    [],
  );
}

export function DataTable<Row, Filter extends string = string>({
  "aria-label": ariaLabel,
  activeFilter,
  columns,
  emptyMessage = "No results",
  filters,
  getRowGroup,
  getRowKey,
  onFilterChange,
  rows,
}: DataTableProps<Row, Filter>) {
  const rowGroups = getRowGroup ? groupDataTableRows(rows, getRowGroup) : [];

  const columnWidths = (
    <colgroup>
      {columns.map((column) => (
        <col key={column.key} style={{ width: column.width }} />
      ))}
    </colgroup>
  );
  const columnHeaders = (
    <thead>
      <tr>
        {columns.map((column) => (
          <th
            className={`dsDataTable__cell--${column.align ?? "left"}`}
            key={column.key}
            scope="col"
          >
            {column.header}
          </th>
        ))}
      </tr>
    </thead>
  );

  function renderedRows(groupRows: Array<Row>) {
    return groupRows.map((row) => (
      <tr key={getRowKey(row)}>
        {columns.map((column) => (
          <td
            className={`dsDataTable__cell--${column.align ?? "left"}`}
            key={column.key}
          >
            {column.render(row)}
          </td>
        ))}
      </tr>
    ));
  }

  return (
    <div className="dsDataTableGroup">
      {filters?.length ? (
        <div aria-label={`${ariaLabel} filters`} className="dsDataTableFilters" role="group">
          {filters.map((filter) => {
            const active = filter.value === activeFilter;

            return (
              <button
                aria-pressed={active}
                className={classNames("dsDataTableFilter", active && "dsDataTableFilter--active")}
                key={filter.value}
                onClick={() => onFilterChange?.(filter.value)}
                type="button"
              >
                {filter.dot ? (
                  <span
                    aria-hidden="true"
                    className="dsDataTableFilter__dot"
                    style={{ backgroundColor: filter.dot }}
                  />
                ) : null}
                <span>{filter.label}</span>
                <span className="dsDataTableFilter__count">{filter.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {rowGroups.length ? (
        <div className="dsDataTableGroups">
          {rowGroups.map((group, index) => (
            <section className="dsDataTableGroupBlock" key={`${group.label}-${index}`}>
              <h2 className="dsDataTableGroupBlock__label">{group.label}</h2>
              <div
                aria-label={`${ariaLabel}: ${group.label}`}
                className="dsDataTable"
                role="region"
                tabIndex={0}
              >
                <table>
                  {columnWidths}
                  {columnHeaders}
                  <tbody>{renderedRows(group.rows)}</tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div aria-label={ariaLabel} className="dsDataTable" role="region" tabIndex={0}>
          <table>
            {columnWidths}
            {columnHeaders}
            <tbody>
              {rows.length ? (
                renderedRows(rows)
              ) : (
                <tr>
                  <td className="dsDataTable__empty" colSpan={columns.length}>
                    {emptyMessage}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export interface CodeBlockProps extends HTMLAttributes<HTMLPreElement> {
  code: string;
  language?: string;
}

export function CodeBlock({
  className,
  code,
  language = "tsx",
  ...props
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="dsCodeBlock">
      <span className="dsCodeBlock__language">{language}</span>
      <pre className={className} {...props}>
        <code>{code}</code>
      </pre>
      <button
        aria-label={copied ? "Copied" : "Copy code"}
        className="dsCodeBlock__copy"
        onClick={() => void copyCode()}
        type="button"
      >
        {copied ? (
          <span aria-hidden="true">✓</span>
        ) : (
          <svg
            aria-hidden="true"
            fill="none"
            height="15"
            viewBox="0 0 16 16"
            width="15"
          >
            <rect height="9" rx="1.5" stroke="currentColor" width="9" x="5" y="5" />
            <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" />
          </svg>
        )}
      </button>
    </div>
  );
}
