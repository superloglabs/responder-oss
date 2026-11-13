import { useEffect, useRef, useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import "./aws-log-streaming.css";

// The "+ Add" button after a row of chips, such as AWS regions or Railway
// environments, with a menu of what can be added.
export function AddChipMenu({ disabled, label, menuClassName, menuLabel, onAdd, options }: {
  disabled: boolean;
  label: string;
  menuClassName?: string;
  menuLabel: string;
  onAdd: (value: string) => void;
  options: Array<{ label: string; value: string }>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Choosing an option closes the menu; focus goes back to the button so
  // keyboard users keep their place.
  const choose = (value: string) => {
    setOpen(false);
    onAdd(value);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    // The focused option unmounts with the menu, so focus goes back to the button.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return <div className="awsAddRegion" ref={root}>
    <button aria-expanded={open} aria-haspopup="listbox" className="awsAddRegion__button" disabled={disabled} onClick={() => setOpen(!open)} ref={trigger} type="button">
      <IconPlus aria-hidden="true" size={13} stroke={2} />{label}
    </button>
    {open && <ul aria-label={menuLabel} className={`awsAddRegion__menu${menuClassName ? ` ${menuClassName}` : ""}`} role="listbox">
      {options.map((option) => <li key={option.value} aria-selected={false} role="option" tabIndex={0}
        onClick={() => choose(option.value)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(option.value); } }}>
        {option.label}
      </li>)}
    </ul>}
  </div>;
}
