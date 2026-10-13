import { XIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { IconButton } from "../design-system";

// A modal on the design system's surfaces. It returns focus to whatever
// opened it.
export function DashboardDialog({
  actions,
  children,
  onClose,
  title,
  wide = false,
}: {
  actions: ReactNode;
  children: ReactNode;
  onClose: () => void;
  title: string;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (trigger instanceof HTMLElement) trigger.focus();
    };
  }, []);
  return (
    <dialog
      aria-labelledby={titleId}
      className={wide ? "dashboardDialog dashboardDialog--wide" : "dashboardDialog"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={ref}
    >
      <header className="dashboardDialog__header">
        <h2 id={titleId}>{title}</h2>
        <IconButton aria-label="Close" onClick={onClose} size="small" variant="ghost">
          <XIcon size={14} />
        </IconButton>
      </header>
      <div className="dashboardDialog__body">{children}</div>
      <footer className="dashboardDialog__footer">{actions}</footer>
    </dialog>
  );
}
