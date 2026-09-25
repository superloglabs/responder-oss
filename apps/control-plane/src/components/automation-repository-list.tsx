import { DotsSixVerticalIcon, GithubLogoIcon, TrashIcon } from "@phosphor-icons/react";
import { type DragEvent, type KeyboardEvent, type ReactNode, useState } from "react";

interface Repository {
  fullName: string;
  id: string;
}

// Selected repositories in run order. The first is the agent's working
// directory; drag a row's handle, or focus it and press the arrow keys, to
// reorder.
export function AutomationRepositoryList({ onMove, onRemove, picker, repositories }: {
  onMove: (repositoryId: string, index: number) => void;
  onRemove: (repositoryId: string) => void;
  picker: ReactNode;
  repositories: Repository[];
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const from = repositories.findIndex((repository) => repository.id === dragging);
  const reorderable = repositories.length > 1;

  function startDrag(event: DragEvent<HTMLElement>, repositoryId: string) {
    const row = event.currentTarget.closest(".automationCreate__row");
    if (row instanceof HTMLElement) event.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", repositoryId);
    setDragging(repositoryId);
  }

  function endDrag() {
    setDragging(null);
    setTarget(null);
  }

  function moveWithKeys(event: KeyboardEvent<HTMLButtonElement>, repositoryId: string, index: number) {
    const next = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null;
    if (next === null) return;
    event.preventDefault();
    if (next < 0 || next >= repositories.length) return;
    onMove(repositoryId, next);
    // The handle moves with its row; keep focus on it.
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-repository-handle="${repositoryId}"]`)?.focus());
  }

  return <div className="automationCreate__rows">
    {repositories.map((repository, index) => {
      const dropClass = dragging && target === index && from !== index
        ? ` automationCreate__row--drop${from < index ? "After" : "Before"}`
        : "";
      return <div
        className={`automationCreate__row${dragging === repository.id ? " automationCreate__row--dragging" : ""}${dropClass}`}
        key={repository.id}
        onDragOver={(event) => {
          if (!dragging) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setTarget(index);
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (dragging && from !== index) onMove(dragging, index);
          endDrag();
        }}
      >
        {reorderable
          ? <button
              aria-label={`Move ${repository.fullName}. Use the up and down arrow keys.`}
              className="automationCreate__dragHandle"
              data-repository-handle={repository.id}
              draggable
              onDragEnd={endDrag}
              onDragStart={(event) => startDrag(event, repository.id)}
              onKeyDown={(event) => moveWithKeys(event, repository.id, index)}
              title="Drag to reorder"
              type="button"
            ><DotsSixVerticalIcon size={16} weight="bold" /></button>
          : null}
        <GithubLogoIcon size={16} />
        <span>{repository.fullName}</span>
        {index === 0 ? <small className="automationCreate__mainDirectory">Main directory</small> : null}
        <button aria-label={`Remove ${repository.fullName}`} className="automationCreate__iconButton" onClick={() => onRemove(repository.id)} type="button"><TrashIcon size={14} /></button>
      </div>;
    })}
    {picker}
  </div>;
}
