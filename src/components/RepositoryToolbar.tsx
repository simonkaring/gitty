import { useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, Download, GitBranch, RefreshCw, Upload } from 'lucide-react';
import { native, errorMessage } from '../model/native';
import { DEFAULT_PULL_MODE, PULL_MODE_LABELS, describeRemoteAction, needsPublish, syncSummary, type PullMode, type RemoteActionRequest, type SyncInfo } from '../model/remote';
import { PublishDialog } from './PublishDialog';
import './workspace-tabs.css';

export interface RepositoryToolbarProps {
  handle: string;
  active: boolean;
  revision: number;
  busy: boolean;
  pickCount: number;
  pickMode: boolean;
  onCreateBranch: () => void;
  onSwitchBranch: () => void;
  onCherryPick: () => void;
  onClearPick: () => void;
  onStartPickMode: () => void;
  onOpenStash: () => void;
  onRefresh: () => void;
  onWrite: (command: string, args: Record<string, unknown>) => Promise<string>;
  notify: (message: string) => void;
}

/** Closes an open dropdown on outside pointerdown or Escape, and returns
 * focus to its toggle so keyboard users never lose their place. Used for
 * both the Pull and Branch menus below. */
function useMenuDismiss(open: boolean, close: () => void, menuRef: RefObject<HTMLElement | null>, toggleRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) { if (!menuRef.current?.contains(event.target as Node)) close(); }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
      toggleRef.current?.focus();
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => { window.removeEventListener('pointerdown', onPointerDown); window.removeEventListener('keydown', onKeyDown, true); };
  }, [open, close, menuRef, toggleRef]);
}

/** Compact Pull / Push / Branch / Stash / Refresh toolbar. Sync info is a
 * passive, local-only read refetched when the active repository changes.
 * RepositoryPane separately schedules background fetches of remote refs. */
export function RepositoryToolbar({ handle, active, revision, busy, pickCount, pickMode, onCreateBranch, onSwitchBranch, onCherryPick, onClearPick, onStartPickMode, onOpenStash, onRefresh, onWrite, notify }: RepositoryToolbarProps) {
  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [syncError, setSyncError] = useState('');
  const [pending, setPending] = useState<'fetch' | 'pull' | 'push' | null>(null);
  const [error, setError] = useState('');
  const [pullMenuOpen, setPullMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const pullMenuRef = useRef<HTMLDivElement>(null);
  const pullToggleRef = useRef<HTMLButtonElement>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const branchToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    native<SyncInfo>('repository_sync_info', { handle }).then(value => { if (live) { setSync(value); setSyncError(''); } }).catch(e => { if (live) setSyncError(errorMessage(e)); });
    return () => { live = false; };
  }, [handle, revision, active]);
  useMenuDismiss(pullMenuOpen, () => setPullMenuOpen(false), pullMenuRef, pullToggleRef);
  useMenuDismiss(branchMenuOpen, () => setBranchMenuOpen(false), branchMenuRef, branchToggleRef);
  // Deactivating the tab makes the browser force-close any top-layer publish
  // dialog in it; keep menus/dialog state in sync rather than leaving a
  // dropdown open behind a hidden pane.
  useEffect(() => { if (!active) { setPullMenuOpen(false); setBranchMenuOpen(false); setPublishOpen(false); } }, [active]);
  const disabled = busy || !active;
  async function run(action: RemoteActionRequest, kind: 'fetch' | 'pull' | 'push') {
    if (disabled || pending) return;
    setPending(kind); setPullMenuOpen(false); setError('');
    try { const output = await onWrite('repository_remote_action', { action }); notify(output || `${describeRemoteAction(action)} complete.`); }
    catch (e) { setError(errorMessage(e)); }
    finally { setPending(null); }
  }
  function push() {
    if (disabled || pending) return;
    if (needsPublish(sync)) { setPublishOpen(true); return; }
    // Resolve the actual configured upstream in Git; remote names can contain
    // slashes and cannot be recovered reliably from the display label.
    void run({ kind: 'push' }, 'push');
  }
  /** Bypasses `run`'s own try/catch: a thrown error must reach the publish
   * dialog so it stays open and shows the failure, instead of closing as if
   * the push had succeeded. */
  async function publish(remote: string, branch: string) {
    if (pending) throw new Error('Another action is already in progress.');
    setPending('push'); setError('');
    try { const output = await onWrite('repository_remote_action', { action: { kind: 'push', remote, branch, setUpstream: true } }); notify(output || 'Publish complete.'); }
    finally { setPending(null); }
  }
  function branchAction(action: () => void) { setBranchMenuOpen(false); action(); }
  return <div className="repository-toolbar" aria-label="Repository actions">
    <div className="repository-toolbar-group">
      <div className="pull-dropdown" ref={pullMenuRef}>
        <button disabled={disabled || !!pending} onClick={() => void run({ kind: 'pull', pullMode: DEFAULT_PULL_MODE }, 'pull')} title={PULL_MODE_LABELS[DEFAULT_PULL_MODE]}><Download size={15} />{pending === 'pull' ? 'Pulling…' : 'Pull'}</button>
        <button ref={pullToggleRef} className="pull-dropdown-toggle" disabled={disabled || !!pending} aria-label="More pull options" aria-expanded={pullMenuOpen} aria-haspopup="menu" onClick={() => setPullMenuOpen(value => !value)}><ChevronDown size={14} /></button>
        {pullMenuOpen && <div className="pull-dropdown-menu" role="menu">
          <button role="menuitem" onClick={() => void run({ kind: 'fetch' }, 'fetch')}>Fetch only</button>
          {(Object.keys(PULL_MODE_LABELS) as PullMode[]).map(mode => <button key={mode} role="menuitem" aria-current={mode === DEFAULT_PULL_MODE} onClick={() => void run({ kind: 'pull', pullMode: mode }, 'pull')}>{PULL_MODE_LABELS[mode]}{mode === DEFAULT_PULL_MODE && ' (default)'}</button>)}
        </div>}
      </div>
      <button disabled={disabled || !!pending} onClick={push}><Upload size={15} />{pending === 'push' ? 'Pushing…' : needsPublish(sync) ? 'Publish…' : 'Push'}</button>
      <span className="repository-sync-badge" data-error={!sync && !!syncError} role="status">{sync ? syncSummary(sync) : syncError ? 'Sync info unavailable' : 'Reading sync info…'}</span>
    </div>
    <span className="repository-toolbar-divider" aria-hidden="true" />
    <div className="repository-toolbar-group">
      <div className="pull-dropdown" ref={branchMenuRef}>
        <button ref={branchToggleRef} disabled={busy} aria-expanded={branchMenuOpen} aria-haspopup="menu" onClick={() => setBranchMenuOpen(value => !value)}><GitBranch size={15} />Branch<ChevronDown size={14} /></button>
        {branchMenuOpen && <div className="pull-dropdown-menu" role="menu">
          <button role="menuitem" onClick={() => branchAction(onCreateBranch)}>New branch…</button>
          <button role="menuitem" onClick={() => branchAction(onSwitchBranch)}>Switch branch…</button>
          {pickMode ? <>
            <button role="menuitem" disabled={!pickCount} onClick={() => branchAction(onCherryPick)}>Cherry-pick {pickCount} selected…</button>
            <button role="menuitem" onClick={() => branchAction(onClearPick)}>Cancel cherry-pick sequence</button>
          </> : <button role="menuitem" onClick={() => branchAction(onStartPickMode)}>Start cherry-pick sequence…</button>}
        </div>}
      </div>
    </div>
    <span className="repository-toolbar-divider" aria-hidden="true" />
    <div className="repository-toolbar-group">
      <button disabled={busy} onClick={onOpenStash}>Stash…</button>
    </div>
    <span className="repository-toolbar-divider" aria-hidden="true" />
    <div className="repository-toolbar-group">
      <button className="secondary-button" disabled={busy} onClick={onRefresh}><RefreshCw size={15} />Refresh</button>
    </div>
    {error && <p className="repository-toolbar-error" role="alert">{error}</p>}
    {publishOpen && <PublishDialog remotes={sync?.remotes ?? []} branch={sync?.branch ?? ''} onPublish={publish} onClose={() => setPublishOpen(false)} />}
  </div>;
}
