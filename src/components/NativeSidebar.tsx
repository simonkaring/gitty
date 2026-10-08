import type { ReactNode } from 'react';
import { Check, ChevronRight, Folder, FolderOpen, FolderGit2, GitBranch, Globe2, Laptop, Tag } from 'lucide-react';
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
  folderOpen: Record<string, boolean>;
  onFolderOpen: (key: string, open: boolean) => void;
}

const GROUPS = [
  { kind: 'local', label: 'Local branches', Icon: Laptop },
  { kind: 'remote', label: 'Remote branches', Icon: Globe2 },
  { kind: 'tag', label: 'Tags', Icon: Tag },
] as const;

interface RefTree { folders: Map<string, RefTree>; refs: RepositoryState['refs'] }
export function buildRefTree(refs: RepositoryState['refs'], prefix: string, remotes: string[] = []): RefTree {
  const root: RefTree = { folders: new Map(), refs: [] };
  for (const ref of refs) {
    if (prefix === 'refs/tags/') { root.refs.push(ref); continue; }
    if (prefix === 'refs/remotes/' && ref.fullName === 'refs/remotes/origin/HEAD') continue;
    let parts: string[];
    if (prefix === 'refs/remotes/') {
      const relative = ref.fullName.slice(prefix.length);
      const remote = [...remotes].sort((a, b) => b.length - a.length).find(name => relative.startsWith(`${name}/`));
      if (!remote) continue;
      const branch = relative.slice(remote.length + 1);
      parts = [remote, ...branch.split('/')];
    } else {
      parts = ref.fullName.slice(prefix.length).split('/');
    }
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), refs: [] });
      node = node.folders.get(part)!;
    }
    node.refs.push(ref);
  }
  return root;
}

export function NativeSidebar({ state, commits, filters, busy, reveal, switchBranch, openMenu, onAction, folderOpen, onFolderOpen }: NativeSidebarProps) {
  const { session } = state;
  return <aside className="sidebar native-sidebar" aria-label="Repository references">
    <div className="workspace-label"><FolderGit2 size={22} /><span>{session.name}<small title={session.root}>{session.root}</small></span></div>
    <div className="native-sidebar-meta">
      <span className="badge" data-tone="accent"><Laptop size={14} />{session.headRef?.replace('refs/heads/', '') ?? 'Detached / unborn HEAD'}</span>
      {session.location.kind === 'wsl' && <span>WSL · {session.location.distribution}</span>}
      {session.linkedWorktree && <span>Linked worktree</span>}
      {session.bare && <span>Bare repository</span>}
      {session.shallow && <span>Shallow clone</span>}
    </div>
    <div className="sidebar-divider" />
    {filters}
    {GROUPS.map(({ kind, label, Icon }) => {
      const refs = state.refs.filter(ref => ref.kind === kind && !(kind === 'remote' && ref.fullName === 'refs/remotes/origin/HEAD'));
      const prefix = kind === 'local' ? 'refs/heads/' : kind === 'remote' ? 'refs/remotes/' : 'refs/tags/';
      const tree = buildRefTree(refs, prefix, state.remotes);
      const renderTree = (node: RefTree, parts: string[] = []): ReactNode => <>
        {[...node.refs].sort((a, b) => a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0).map(ref => <div className={`ref-action-row${ref.fullName === session.headRef ? ' current' : ''}`} key={ref.fullName} onContextMenu={event => { event.preventDefault(); openMenu({ oid: ref.commitId, ref: ref.fullName }, event.clientX, event.clientY, event.currentTarget.querySelector('button')!); }}>
          <button className="ref-item" title={ref.fullName} aria-label={`${kind} ${ref.fullName}`} aria-current={ref.fullName === session.headRef ? 'true' : undefined} disabled={busy} draggable={ref.kind !== 'tag'}
            onDragStart={event => { event.stopPropagation(); if (ref.kind === 'tag') { event.preventDefault(); return; } event.dataTransfer.clearData(COMMIT_DRAG_TYPE); event.dataTransfer.setData(REF_DRAG_TYPE, ref.fullName); event.dataTransfer.effectAllowed = 'copy'; }}
            onDragOver={event => { if (ref.fullName === session.headRef && [REF_DRAG_TYPE, COMMIT_DRAG_TYPE].some(type => event.dataTransfer.types.includes(type))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={event => { event.preventDefault(); event.stopPropagation(); const action = graphDropAction(event.dataTransfer, ref.fullName, session.headRef, commits, state.refs); if (action) onAction(action); }}
            onClick={() => reveal(ref.commitId)} onDoubleClick={() => { if (ref.kind === 'local' || (ref.kind === 'remote' && ref.fullName.startsWith('refs/remotes/origin/') && ref.fullName !== 'refs/remotes/origin/HEAD')) switchBranch(ref.fullName); }}
            onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu({ oid: ref.commitId, ref: ref.fullName }, rect.left, rect.bottom, event.currentTarget); } }}>
            {kind === 'tag' ? <Icon size={14} aria-hidden="true" /> : ref.fullName === session.headRef ? <Check className="current-branch-check" size={14} aria-hidden="true" /> : <GitBranch size={14} aria-hidden="true" />}<span>{kind === 'tag' ? ref.name : ref.name.split('/').at(-1)}</span>
          </button><button className="icon-button sm" aria-label={`Actions for ${ref.fullName}`} aria-haspopup="menu" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openMenu({ oid: ref.commitId, ref: ref.fullName }, rect.left, rect.bottom, event.currentTarget); }}>…</button>
        </div>)}
        {[...node.folders].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, child]) => {
          const key = `${session.handle}:${kind}:${[...parts, name].join('/')}`;
          const currentPrefix = kind === 'local' ? session.headRef?.replace(prefix, '') : undefined;
          const initiallyOpen = !!currentPrefix?.startsWith(`${[...parts, name].join('/')}/`);
          return <details className="reference-folder" key={key} open={folderOpen[key] ?? initiallyOpen} onToggle={event => onFolderOpen(key, event.currentTarget.open)}>
            <summary title={[...parts, name].join('/')}>
              <ChevronRight className="reference-folder-chevron" size={12} aria-hidden="true" />
              {kind === 'remote' && parts.length === 0 ? <Globe2 className="reference-folder-icon" size={14} aria-hidden="true" /> : <><Folder className="reference-folder-icon folder-closed" size={14} aria-hidden="true" /><FolderOpen className="reference-folder-icon folder-open" size={14} aria-hidden="true" /></>}
              <span className="reference-folder-name">{name}</span>
            </summary>
            <div className="reference-folder-children">{renderTree(child, [...parts, name])}</div>
          </details>;
        })}
      </>;
      return <details className="reference-group" key={kind} open={kind === 'local'}>
        <summary>{kind !== 'tag' && <Icon size={15} aria-hidden="true" />}{label}<span className="count">{refs.length}</span></summary>
        <div className="reference-tree">{renderTree(tree)}</div>
        {!refs.length && <p className="empty-category">No references</p>}
      </details>;
    })}
    {state.remotes.length > 0 && <details className="reference-group"><summary>Remotes<span className="count">{state.remotes.length}</span></summary>{state.remotes.map(remote => <p key={remote}>{remote}</p>)}</details>}
  </aside>;
}
