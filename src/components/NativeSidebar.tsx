import { Fragment, useRef, useState, type ReactNode } from 'react';
import { Icons } from './icons';
import type { CommitSummary, RepositoryState } from '../model/repository';
import { acceptsGraphDrop, graphDropAction, REF_DRAG_TYPE, COMMIT_DRAG_TYPE } from './HistoryGraph';
import type { ActionContext } from './OperationDialog';
import { folderLabel, type BranchFolder } from '../model/branchDelete';
import { DEFAULT_SIDEBAR_SECTIONS, type SidebarSectionConfig, type SidebarSectionId } from '../model/settings';
import type { StashActionRequest } from '../model/remote';
import { OrderMenu } from './OrderMenu';

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
  openFolderMenu?: (folder: BranchFolder, x: number, y: number, trigger: HTMLElement) => void;
  worktrees?: ReactNode;
  onHoverRef?: (ref: string | null) => void;
  /** Order and visibility of the sections; the options menu only appears when `onSectionsChange` is given. */
  sections?: SidebarSectionConfig[];
  onSectionsChange?: (sections: SidebarSectionConfig[]) => void;
  /** Stash actions from the Stashes section; absent hides the actions button. */
  onStash?: (action: StashActionRequest) => void;
}

export const SECTION_LABELS: Record<SidebarSectionId, string> = { worktrees: 'Worktrees', local: 'Local branches', remote: 'Remote branches', tag: 'Tags', stash: 'Stashes', remotes: 'Remotes' };

const GROUPS = [
  { kind: 'local', label: 'Local branches', Icon: Icons.Laptop },
  { kind: 'remote', label: 'Remote branches', Icon: Icons.Globe2 },
  { kind: 'tag', label: 'Tags', Icon: Icons.Tag },
  { kind: 'stash', label: 'Stashes', Icon: Icons.Archive },
] as const;

/** `git stash list` message as shown in the sidebar: "On main: fixed login" is just "fixed login". */
export function stashMessage(message: string): string {
  return message.replace(/^On .*?: /, '') || message;
}

interface RefTree { folders: Map<string, RefTree>; refs: RepositoryState['refs'] }
export function buildRefTree(refs: RepositoryState['refs'], prefix: string, remotes: string[] = []): RefTree {
  const root: RefTree = { folders: new Map(), refs: [] };
  for (const ref of refs) {
    if (prefix === 'refs/tags/' || prefix === 'refs/stash') { root.refs.push(ref); continue; }
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

export function NativeSidebar({ state, commits, filters, busy, reveal, switchBranch, openMenu, onAction, folderOpen, onFolderOpen, openFolderMenu, worktrees, onHoverRef, sections = DEFAULT_SIDEBAR_SECTIONS, onSectionsChange, onStash }: NativeSidebarProps) {
  const { session } = state;
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Matching the stash dialog: a second click on the same stash confirms a drop.
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const nodes: Record<SidebarSectionId, ReactNode> = {    worktrees,
    local: null, remote: null, tag: null, stash: null,
    remotes: state.remotes.length > 0 && <details className="reference-group" data-section="remotes"><summary><Icons.Cloud size={15} aria-hidden="true" />Remotes<span className="count">{state.remotes.length}</span></summary>{state.remotes.map(remote => <p key={remote}>{remote}</p>)}</details>,
  };
  for (const { kind, label, Icon } of GROUPS) {
    const refs = state.refs.filter(ref => ref.kind === kind && !(kind === 'remote' && ref.fullName === 'refs/remotes/origin/HEAD'));
    const prefix = kind === 'local' ? 'refs/heads/' : kind === 'remote' ? 'refs/remotes/' : kind === 'stash' ? 'refs/stash' : 'refs/tags/';
    const tree = buildRefTree(refs, prefix, state.remotes);
    const renderTree = (node: RefTree, parts: string[] = []): ReactNode => <>
      {[...node.refs].sort((a, b) => a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0).map(ref => <div className={`ref-action-row${ref.fullName === session.headRef ? ' current' : ''}`} key={ref.fullName} onMouseEnter={() => onHoverRef?.(ref.fullName)} onMouseLeave={() => onHoverRef?.(null)} onFocus={() => onHoverRef?.(ref.fullName)} onBlur={() => onHoverRef?.(null)} onContextMenu={event => { event.preventDefault(); openMenu({ oid: ref.commitId, ref: ref.fullName }, event.clientX, event.clientY, event.currentTarget.querySelector('button')!); }}>
        <button className="ref-item" title={kind === 'stash' ? `${ref.fullName}: ${stashMessage(ref.name)}` : ref.fullName} aria-label={`${kind} ${ref.fullName}`} aria-current={ref.fullName === session.headRef ? 'true' : undefined} disabled={busy} draggable={ref.kind === 'local' || ref.kind === 'remote'}
          onDragStart={event => { event.stopPropagation(); if (ref.kind !== 'local' && ref.kind !== 'remote') { event.preventDefault(); return; } event.dataTransfer.clearData(COMMIT_DRAG_TYPE); event.dataTransfer.setData(REF_DRAG_TYPE, ref.fullName); event.dataTransfer.effectAllowed = 'copy'; }}
          onDragOver={event => { if (!busy && acceptsGraphDrop(event.dataTransfer, ref, session.headRef)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
          onDrop={event => { event.preventDefault(); event.stopPropagation(); const action = graphDropAction(event.dataTransfer, ref.fullName, session.headRef, commits, state.refs); if (action) onAction(action); }}
          onClick={() => reveal(ref.commitId)} onDoubleClick={() => { if (ref.kind === 'local' || (ref.kind === 'remote' && ref.fullName.startsWith('refs/remotes/origin/') && ref.fullName !== 'refs/remotes/origin/HEAD')) switchBranch(ref.fullName); }}
          onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu({ oid: ref.commitId, ref: ref.fullName }, rect.left, rect.bottom, event.currentTarget); } }}>
          {kind === 'tag' || kind === 'stash' ? <Icon size={14} aria-hidden="true" /> : ref.fullName === session.headRef ? <Icons.Check className="current-branch-check" size={14} aria-hidden="true" /> : <Icons.GitBranch size={14} aria-hidden="true" />}<span>{kind === 'tag' || kind === 'stash' ? (kind === 'stash' ? stashMessage(ref.name) : ref.name) : ref.name.split('/').at(-1)}</span>
        </button>{kind === 'stash' && onStash ? <>
          <button className="icon-button sm" aria-label="Pop stash" title="Pop stash" disabled={busy} onClick={() => onStash({ kind: 'pop', oid: ref.commitId, restoreIndex: true })}><Icons.ArchiveRestore size={13} /></button>
          <button className="icon-button sm" data-danger={confirmDrop === ref.commitId ? 'true' : undefined} aria-label={confirmDrop === ref.commitId ? 'Confirm drop stash' : 'Drop stash'} title={confirmDrop === ref.commitId ? 'Click again to drop' : 'Drop stash'} disabled={busy} onClick={() => { if (confirmDrop === ref.commitId) { setConfirmDrop(null); onStash({ kind: 'drop', oid: ref.commitId }); } else setConfirmDrop(ref.commitId); }}><Icons.Trash2 size={13} /></button>
        </> : <button className="icon-button sm" aria-label={`Actions for ${ref.fullName}`} aria-haspopup="menu" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openMenu({ oid: ref.commitId, ref: ref.fullName }, rect.left, rect.bottom, event.currentTarget); }}>…</button>}
      </div>)}
      {[...node.folders].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, child]) => {
        const key = `${session.handle}:${kind}:${[...parts, name].join('/')}`;
        const currentPrefix = kind === 'local' ? session.headRef?.replace(prefix, '') : undefined;
        const initiallyOpen = !!currentPrefix?.startsWith(`${[...parts, name].join('/')}/`);
        const path = [...parts, name];
        const folder: BranchFolder | null = kind === 'local' ? { kind: 'local', path: path.join('/') }
          : kind === 'remote' && path.length > 1 && path[0] === 'origin' ? { kind: 'origin', path: path.slice(1).join('/') } : null;
        return <details className="reference-folder" key={key} open={folderOpen[key] ?? initiallyOpen} onToggle={event => onFolderOpen(key, event.currentTarget.open)}>
          <summary title={path.join('/')}
            onContextMenu={folder && openFolderMenu ? event => { event.preventDefault(); openFolderMenu(folder, event.clientX, event.clientY, event.currentTarget); } : undefined}
            onKeyDown={folder && openFolderMenu ? event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openFolderMenu(folder, rect.left, rect.bottom, event.currentTarget); } } : undefined}>
            <Icons.ChevronRight className="reference-folder-chevron" size={12} aria-hidden="true" />
            {kind === 'remote' && parts.length === 0 ? <Icons.Globe2 className="reference-folder-icon" size={14} aria-hidden="true" /> : <><Icons.Folder className="reference-folder-icon folder-closed" size={14} aria-hidden="true" /><Icons.FolderOpen className="reference-folder-icon folder-open" size={14} aria-hidden="true" /></>}
            <span className="reference-folder-name">{name}</span>
            {folder && openFolderMenu && <button type="button" className="icon-button sm reference-folder-actions" aria-label={`Actions for folder ${folderLabel(folder)}`} aria-haspopup="menu" onClick={event => { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); openFolderMenu(folder, rect.left, rect.bottom, event.currentTarget); }}>…</button>}
          </summary>
          <div className="reference-folder-children">{renderTree(child, [...parts, name])}</div>
        </details>;
      })}
    </>;
    nodes[kind] = <details className="reference-group" data-section={kind} open={kind === 'local'}>
      <summary><Icon size={15} aria-hidden="true" />{label}<span className="count">{refs.length}</span></summary>
      <div className="reference-tree">{renderTree(tree)}</div>
      {!refs.length && <p className="empty-category">No references</p>}
    </details>;
  }
  return <aside className="sidebar native-sidebar" aria-label="Repository references">
    <div className="workspace-label"><Icons.FolderGit2 size={22} /><span>{session.name}<small title={session.root}>{session.root}</small></span>
      {onSectionsChange && <div className="sidebar-options">
        <button ref={optionsButton} type="button" className="icon-button sm" aria-label="Customize sidebar sections" title="Customize sidebar sections" aria-haspopup="dialog" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(open => !open)}><Icons.Settings size={15} /></button>
        {optionsOpen && <OrderMenu className="sidebar-section-menu" items={sections} labels={SECTION_LABELS} defaults={DEFAULT_SIDEBAR_SECTIONS} title="Sections" ariaLabel="Sidebar sections settings" closeLabel="Close sidebar section settings" minVisible={0} triggerRef={optionsButton} onChange={onSectionsChange} onClose={() => setOptionsOpen(false)} />}
      </div>}
    </div>
    <div className="native-sidebar-meta">
      <span className="badge" data-tone="accent"><Icons.Laptop size={14} />{session.headRef?.replace('refs/heads/', '') ?? 'Detached / unborn HEAD'}</span>
      {session.location.kind === 'wsl' && <span>WSL · {session.location.distribution}</span>}
      {session.location.kind === 'ssh' && <span>SSH · {session.location.host}{session.location.user ? ` (${session.location.user})` : ''}</span>}
      {session.linkedWorktree && <span>Linked worktree</span>}
      {session.bare && <span>Bare repository</span>}
      {session.shallow && <span>Shallow clone</span>}
    </div>
    <div className="sidebar-divider" />
    {filters}
    {sections.filter(section => section.visible).map(({ id }) => <Fragment key={id}>{nodes[id]}</Fragment>)}
  </aside>;
}
