import { type ReactNode, useEffect, useId, useRef } from "react";
import { XIcon } from "@phosphor-icons/react";

export function AutomationEditorDialog({ children, onClose, title }: {
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
      dialog?.close();
      if (trigger instanceof HTMLElement) trigger.focus();
    };
  }, []);
  return (
    <dialog aria-labelledby={titleId} className="automationEditorDialog" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
      if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }
    }} ref={ref}>
      <header><h2 id={titleId}>{title}</h2><button aria-label="Close" onClick={onClose} type="button"><XIcon size={16} /></button></header>
      <div className="automationEditorDialog__body">{children}</div>
      <footer><button className="automationCreate__manage" onClick={onClose} type="button">Done</button></footer>
    </dialog>
  );
}
