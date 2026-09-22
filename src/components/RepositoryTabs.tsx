import type { KeyboardEvent } from 'react';
import { FolderGit2, Loader2, Plus, X } from 'lucide-react';
import './workspace-tabs.css';

export interface RepositoryTabSummary { id: string; title: string; busy: boolean; branch: string | null; dirty: boolean }

/** Standard roving-tabindex tablist keyboard pattern: only the active tab is
 * in the Tab order; Left/Right/Home/End move focus and, matching most tab
 * strips (browser tabs, editor tabs), immediately activate the destination. */
function handleTablistKeyDown(event: KeyboardEvent<HTMLElement>, ids: string[], activeId: string | null, onSelect: (id: string) => void) {
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

export function RepositoryTabs({ tabs, activeId, onSelect, onClose, onNew }: {
  tabs: RepositoryTabSummary[]; activeId: string | null; onSelect: (id: string) => void; onClose: (id: string) => void; onNew: () => void;
}) {
  const ids = tabs.map(tab => tab.id);
  return <div className="repository-tabs-row">
    <nav className="repository-tabs" aria-label="Open repositories" role="tablist" onKeyDown={event => handleTablistKeyDown(event, ids, activeId, onSelect)}>
      {tabs.map(tab => {
        const selected = tab.id === activeId;
        return <div key={tab.id} className="repository-tab" data-selected={selected}>
          <button id={`tab-${tab.id}`} className="repository-tab-select" role="tab" type="button" aria-selected={selected} aria-controls={`tabpanel-${tab.id}`} tabIndex={selected ? 0 : -1} onClick={() => onSelect(tab.id)} title={tab.branch ? `${tab.title} · ${tab.branch}` : tab.title}>
            <FolderGit2 size={14} className="repository-tab-icon" />
            {tab.busy && <span className="repository-tab-busy" aria-hidden="true" title="An operation is running" />}
            {tab.dirty && !tab.busy && <span className="repository-tab-dirty" aria-hidden="true" title="Uncommitted changes" />}
            <span className="repository-tab-text"><span className="repository-tab-title">{tab.title}</span>{tab.branch && <span className="repository-tab-branch">{tab.branch}</span>}</span>
          </button>
          <button className="repository-tab-close" tabIndex={selected ? 0 : -1} aria-label={tab.busy ? `Cannot close ${tab.title}: an operation is running` : `Close ${tab.title}`} disabled={tab.busy} title={tab.busy ? 'An operation is running in this tab' : 'Close tab'} onClick={() => onClose(tab.id)}>
            {tab.busy ? <Loader2 size={13} className="spin" /> : <X size={13} />}
          </button>
        </div>;
      })}
    </nav>
    <button className="repository-tab-new" aria-label="Open another repository in a new tab" title="New tab" onClick={onNew}><Plus size={16} /></button>
  </div>;
}
