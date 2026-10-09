import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { FolderGit2, Loader2, Plus, X } from 'lucide-react';

export interface RepositoryTabSummary { id: string; title: string; busy: boolean; branch: string | null; dirty: boolean; start?: boolean }

/** Standard roving-tabindex tablist keyboard pattern: only the active tab is
 * in the Tab order; Left/Right/Home/End move focus and, matching most tab
 * strips (browser tabs, editor tabs), immediately activate the destination. */
function handleTablistKeyDown(event: KeyboardEvent<HTMLElement>, ids: string[], activeId: string | null, onSelect: (id: string) => void) {
  if (!ids.length) return;
  const index = ids.indexOf(activeId ?? '');
  let nextIndex: number | null = null;
  if (event.key === 'ArrowRight') nextIndex = index < 0 ? 0 : (index + 1) % ids.length;
  else if (event.key === 'ArrowLeft') nextIndex = index < 0 ? ids.length - 1 : (index - 1 + ids.length) % ids.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = ids.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  onSelect(ids[nextIndex]);
  requestAnimationFrame(() => document.getElementById(`tab-${ids[nextIndex!]}`)?.focus());
}

export function RepositoryTabs({ tabs, activeId, onSelect, onClose, onMove, onNew }: {
  tabs: RepositoryTabSummary[]; activeId: string | null; onSelect: (id: string) => void; onClose: (id: string) => void; onMove: (id: string, targetId: string) => void; onNew: () => void;
}) {
  const ids = tabs.map(tab => tab.id);
  const strip = useRef<HTMLElement>(null);
  const drag = useRef<{ id: string; pointerId: number; x: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  function movePointer(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || !strip.current) return;
    if (!current.moved && Math.abs(event.clientX - current.x) < 5) return;
    if (!current.moved) strip.current.setPointerCapture(event.pointerId);
    current.moved = true;
    suppressClick.current = true;
    setDraggingId(current.id);
    const bounds = strip.current.getBoundingClientRect();
    // Keep overflowed tabs reachable while dragging near either edge.
    if (event.clientX < bounds.left + 24) strip.current.scrollLeft -= 20;
    else if (event.clientX > bounds.right - 24) strip.current.scrollLeft += 20;
    const from = ids.indexOf(current.id);
    if (from < 0) return;
    let destination = from;
    Array.from(strip.current.children).forEach((element, index) => {
      if (index === from) return;
      const rect = element.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      if (index < from && event.clientX < midpoint) destination = Math.min(destination, index);
      if (index > from && event.clientX > midpoint) destination = Math.max(destination, index);
    });
    if (destination !== from) onMove(current.id, ids[destination]);
  }

  function endPointer(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDraggingId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return <div className="repository-tabs-row" data-tauri-drag-region>
    <nav ref={strip} className="repository-tabs" aria-label="Open repositories" role="tablist" onKeyDown={event => handleTablistKeyDown(event, ids, activeId, onSelect)}
      onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer}
      onLostPointerCapture={event => { if (event.target === event.currentTarget || !drag.current?.moved) endPointer(event); }} data-tauri-drag-region>
      {tabs.map(tab => {
        const selected = tab.id === activeId;
        return <div key={tab.id} className="repository-tab" data-selected={selected} data-dragging={draggingId === tab.id}>
          <button id={`tab-${tab.id}`} className="repository-tab-select" role="tab" type="button" aria-selected={selected} aria-controls={`tabpanel-${tab.id}`} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" tabIndex={selected ? 0 : -1}
            onPointerDown={event => {
              if (event.button !== 0 || drag.current) return;
              suppressClick.current = false;
              drag.current = { id: tab.id, pointerId: event.pointerId, x: event.clientX, moved: false };
              // Preserve the button's ordinary click target until a drag starts.
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onClick={event => { if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; } onSelect(tab.id); }}
            onKeyDown={event => {
              if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
              event.preventDefault();
              event.stopPropagation();
              const target = ids[ids.indexOf(tab.id) + (event.key === 'ArrowLeft' ? -1 : 1)];
              if (target) {
                onMove(tab.id, target);
                requestAnimationFrame(() => document.getElementById(`tab-${tab.id}`)?.focus());
              }
            }}
            title={`${tab.branch ? `${tab.title} · ${tab.branch}` : tab.title} — Drag to reorder; Alt+Left/Right to move`}>
            {tab.start ? <Plus size={14} className="repository-tab-icon" /> : <FolderGit2 size={14} className="repository-tab-icon" />}
            {tab.busy && <span className="repository-tab-busy" aria-hidden="true" title="An operation is running" />}
            {tab.dirty && !tab.busy && <span className="repository-tab-dirty" aria-hidden="true" title="Uncommitted changes" />}
            <span className="repository-tab-text"><span className="repository-tab-title">{tab.title}</span>{tab.branch && <span className="repository-tab-branch">{tab.branch}</span>}</span>
          </button>
          <button className="icon-button sm repository-tab-close" tabIndex={selected ? 0 : -1} aria-label={tab.busy ? `Cannot close ${tab.title}: an operation is running` : `Close ${tab.title}`} disabled={tab.busy} title={tab.busy ? 'An operation is running in this tab' : 'Close tab'} onClick={() => onClose(tab.id)}>
            {tab.busy ? <Loader2 size={13} className="spin" /> : <X size={13} />}
          </button>
        </div>;
      })}
    </nav>
    <button className="icon-button repository-tab-new" aria-label="New tab" title="New tab" onClick={onNew}><Plus size={16} /></button>
  </div>;
}
