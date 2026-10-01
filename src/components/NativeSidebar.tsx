import type { ReactNode } from 'react';
import { FolderGit2, GitBranch, Globe2, Tag } from 'lucide-react';
import type { CommitSummary, RepositoryState } from '../model/repository';
import { graphDropAction, REF_DRAG_TYPE, COMMIT_DRAG_TYPE } from './HistoryGraph';
import type { ActionContext } from './OperationDialog';

interface NativeSidebarProps {
  state: RepositoryState;
  commits: CommitSummary[];
  filters: ReactNode;
  busy: boolean;
  reveal: (id: string) => void;
  switchBranch: (ref: string) => void;
  openMenu: (context: ActionContext, x: number, y: number, trigger: HTMLElement) => void;
  onAction: (context: ActionContext) => void;
}

const GROUPS = [
  { kind: 'local', label: 'Branches', Icon: GitBranch },
  { kind: 'remote', label: 'Remote branches', Icon: Globe2 },
  { kind: 'tag', label: 'Tags', Icon: Tag },
] as const;

export function NativeSidebar({ state, commits, filters, busy, reveal, switchBranch, openMenu, onAction }: NativeSidebarProps) {
  const { session } = state;
  return <aside className="sidebar native-sidebar" aria-label="Repository references">
    <div className="workspace-label"><FolderGit2 size={22} /><span>{session.name}<small title={session.root}>{session.root}</small></span></div>
    <div className="native-sidebar-meta">
      <span className="badge" data-tone="accent"><GitBranch size={14} />{session.headRef?.replace('refs/heads/', '') ?? 'Detached / unborn HEAD'}</span>
      {session.location.kind === 'wsl' && <span>WSL · {session.location.distribution}</span>}
      {session.linkedWorktree && <span>Linked worktree</span>}
      {session.bare && <span>Bare repository</span>}
      {session.shallow && <span>Shallow clone</span>}
    </div>
    <div className="sidebar-divider" />
    {filters}
    {GROUPS.map(({ kind, label, Icon }) => {
      const refs = state.refs.filter(ref => ref.kind === kind);
      return <details className="reference-group" key={kind} open={kind === 'local'}>
        <summary>{label}<span className="count">{refs.length}</span></summary>
        {refs.map(ref => <div className="ref-action-row" key={ref.fullName} onContextMenu={event => { event.preventDefault(); openMenu({ oid: ref.commitId, ref: ref.fullName }, event.clientX, event.clientY, event.currentTarget.querySelector('button')!); }}>
          <button className="ref-item" title={ref.fullName} disabled={busy} draggable={ref.kind !== 'tag'}
            onDragStart={event => { event.stopPropagation(); if (ref.kind === 'tag') { event.preventDefault(); return; } event.dataTransfer.clearData(COMMIT_DRAG_TYPE); event.dataTransfer.setData(REF_DRAG_TYPE, ref.fullName); event.dataTransfer.effectAllowed = 'copy'; }}
            onDragOver={event => { if (ref.fullName === session.headRef && [REF_DRAG_TYPE, COMMIT_DRAG_TYPE].some(type => event.dataTransfer.types.includes(type))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={event => { event.preventDefault(); event.stopPropagation(); const action = graphDropAction(event.dataTransfer, ref.fullName, session.headRef, commits, state.refs); if (action) onAction(action); }}
            onClick={() => reveal(ref.commitId)}
            onDoubleClick={() => { if (ref.kind === 'local') switchBranch(ref.fullName); }}
            onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu({ oid: ref.commitId, ref: ref.fullName }, rect.left, rect.bottom, event.currentTarget); } }}>
            <Icon size={15} /><span>{ref.name}</span>{ref.fullName === session.headRef && <span className="current-branch-dot" />}
          </button>
          <button className="icon-button sm" aria-label={`Actions for ${ref.name}`} onClick={() => onAction({ oid: ref.commitId, ref: ref.fullName })}>…</button>
        </div>)}
        {!refs.length && <p className="empty-category">No references</p>}
      </details>;
    })}
    {state.remotes.length > 0 && <details className="reference-group"><summary>Remotes<span className="count">{state.remotes.length}</span></summary>{state.remotes.map(remote => <p key={remote}>{remote}</p>)}</details>}
  </aside>;
}
