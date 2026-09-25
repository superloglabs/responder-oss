import { type ReactNode, useEffect, useId, useRef } from "react";
import { XIcon } from "@phosphor-icons/react";

// `actions` replaces the default Done button in the footer.
export function AutomationEditorDialog({ actions, children, onClose, title }: {
  actions?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  title: string;
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
  function close() {
    if (ref.current?.open) ref.current.close();
    onClose();
  }
  return (
    <dialog aria-labelledby={titleId} className="automationEditorDialog" onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => {
      if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }
    }} ref={ref}>
      <header><h2 id={titleId}>{title}</h2><button aria-label="Close" onClick={close} type="button"><XIcon size={16} /></button></header>
      <div className="automationEditorDialog__body">{children}</div>
      <footer>{actions ?? <button className="automationCreate__manage" onClick={close} type="button">Done</button>}</footer>
    </dialog>
  );
}
