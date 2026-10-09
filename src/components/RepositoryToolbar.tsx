import { useEffect, useRef, useState } from 'react';
import { useDismiss, useMenuKeyboard } from './ui';
import { Archive, Check, ChevronDown, Download, GitBranch, RefreshCw, Upload, UserRound } from 'lucide-react';
import { native, errorMessage } from '../model/native';
import { DEFAULT_PULL_MODE, PULL_MODE_LABELS, remoteSuccessMessage, needsPublish, syncSummary, type PullMode, type RemoteActionRequest, type SyncInfo } from '../model/remote';
import { PublishDialog } from './PublishDialog';
import { describeFetchStatus, type FetchStatus } from '../model/autoFetch';
import { RepositoryIdentityDialog } from './RepositoryIdentityDialog';
import type { CommitIdentity, GitIdentityValues } from '../model/repository';

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
  fetchStatus?: FetchStatus;
}

const IDLE_FETCH: FetchStatus = { kind: 'idle' };

/** Compact Pull / Push / Branch / Stash / Refresh toolbar. Sync info is a
 * passive, local-only read refetched when the active repository changes.
 * RepositoryPane separately schedules background fetches of remote refs. */
export function RepositoryToolbar({ handle, active, revision, busy, pickCount, pickMode, onCreateBranch, onSwitchBranch, onCherryPick, onClearPick, onStartPickMode, onOpenStash, onRefresh, onWrite, notify, fetchStatus = IDLE_FETCH }: RepositoryToolbarProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(timer);
  }, [active, fetchStatus]);
  const fetchLabel = describeFetchStatus(fetchStatus, now);
  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [syncError, setSyncError] = useState('');
  const [pending, setPending] = useState<'fetch' | 'pull' | 'push' | null>(null);
  // Briefly swaps the finished action's icon for a self-drawing check.
  const [done, setDone] = useState<'fetch' | 'pull' | 'push' | null>(null);
  useEffect(() => { if (!done) return; const timer = setTimeout(() => setDone(null), 1600); return () => clearTimeout(timer); }, [done]);
  const [pullMenuOpen, setPullMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
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
  useDismiss(pullMenuOpen, () => setPullMenuOpen(false), [pullMenuRef], pullToggleRef);
  useDismiss(branchMenuOpen, () => setBranchMenuOpen(false), [branchMenuRef], branchToggleRef);
  useMenuKeyboard(pullMenuRef, pullMenuOpen, () => setPullMenuOpen(false));
  useMenuKeyboard(branchMenuRef, branchMenuOpen, () => setBranchMenuOpen(false));
  // Deactivating the tab makes the browser force-close any top-layer publish
  // dialog in it; keep menus/dialog state in sync rather than leaving a
  // dropdown open behind a hidden pane.
  useEffect(() => { if (!active) { setPullMenuOpen(false); setBranchMenuOpen(false); setPublishOpen(false); setIdentityOpen(false); } }, [active]);
  const disabled = busy || !active;
  async function run(action: RemoteActionRequest, kind: 'fetch' | 'pull' | 'push') {
    if (disabled || pending) return;
    setPending(kind); setPullMenuOpen(false);
    try { const output = await onWrite('repository_remote_action', { action }); notify(remoteSuccessMessage(action, output, sync?.branch)); setDone(kind === 'fetch' ? 'pull' : kind); }
    catch { /* The pane owns the dismissible operation error. */ }
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
    setPending('push');
    const action: RemoteActionRequest = { kind: 'push', remote, branch, setUpstream: true };
    try { const output = await onWrite('repository_remote_action', { action }); notify(remoteSuccessMessage(action, output)); setDone('push'); }
    finally { setPending(null); }
  }
  function branchAction(action: () => void) { setBranchMenuOpen(false); action(); }
  return <><div className="repository-toolbar" aria-label="Repository actions">
    <div className="toolbar-zone toolbar-start">
      <span className="badge" data-tone={!sync && syncError ? 'red' : undefined} role="status">{sync ? syncSummary(sync) : syncError ? 'Sync info unavailable' : 'Reading sync info…'}</span>
      {fetchLabel && <span className="repository-fetch-status" data-error={fetchStatus.kind === 'failed'} title={fetchStatus.kind === 'failed' ? fetchStatus.message : undefined}>{fetchLabel}{fetchStatus.kind === 'failed' && <span className="sr-only">: {fetchStatus.message}</span>}</span>}
    </div>
    <div className="toolbar-zone toolbar-center">
    <div className="repository-toolbar-group">
      <div className="pull-dropdown" ref={pullMenuRef}>
        <button className="sync-button pull" data-pending={pending === 'pull' || pending === 'fetch'} disabled={disabled || !!pending} onClick={() => void run({ kind: 'pull', pullMode: DEFAULT_PULL_MODE }, 'pull')} title={PULL_MODE_LABELS[DEFAULT_PULL_MODE]}>{done === 'pull' ? <Check size={15} className="done-check" /> : <Download size={15} />}{pending === 'pull' ? 'Pulling…' : 'Pull'}</button>
        <button ref={pullToggleRef} className="pull-dropdown-toggle" disabled={disabled || !!pending} aria-label="More pull options" aria-expanded={pullMenuOpen} aria-haspopup="menu" onClick={() => setPullMenuOpen(value => !value)}><ChevronDown size={14} /></button>
        {pullMenuOpen && <div className="menu pull-dropdown-menu" role="menu">
          <button role="menuitem" onClick={() => void run({ kind: 'fetch' }, 'fetch')}>Fetch only</button>
          {(Object.keys(PULL_MODE_LABELS) as PullMode[]).map(mode => <button key={mode} role="menuitem" aria-current={mode === DEFAULT_PULL_MODE} onClick={() => void run({ kind: 'pull', pullMode: mode }, 'pull')}>{PULL_MODE_LABELS[mode]}{mode === DEFAULT_PULL_MODE && ' (default)'}</button>)}
        </div>}
      </div>
      <button className="sync-button push" data-pending={pending === 'push'} disabled={disabled || !!pending} onClick={push}>{done === 'push' ? <Check size={15} className="done-check" /> : <Upload size={15} />}{pending === 'push' ? 'Pushing…' : needsPublish(sync) ? 'Publish…' : 'Push'}</button>
    </div>
    <span className="toolbar-sep" aria-hidden="true" />
      <div className="pull-dropdown" ref={branchMenuRef}>
        <button ref={branchToggleRef} disabled={busy} aria-expanded={branchMenuOpen} aria-haspopup="menu" onClick={() => setBranchMenuOpen(value => !value)}><GitBranch size={15} />Branch<ChevronDown size={14} /></button>
        {branchMenuOpen && <div className="menu pull-dropdown-menu" role="menu">
          <button role="menuitem" onClick={() => branchAction(onCreateBranch)}>New branch…</button>
          <button role="menuitem" onClick={() => branchAction(onSwitchBranch)}>Switch branch…</button>
          {pickMode ? <>
            <button role="menuitem" disabled={!pickCount} onClick={() => branchAction(onCherryPick)}>Cherry-pick {pickCount} selected…</button>
            <button role="menuitem" onClick={() => branchAction(onClearPick)}>Cancel cherry-pick sequence</button>
          </> : <button role="menuitem" onClick={() => branchAction(onStartPickMode)}>Start cherry-pick sequence…</button>}
        </div>}
      </div>
      <button disabled={busy} onClick={onOpenStash}><Archive size={15} />Stash…</button>
    </div>
    <div className="toolbar-zone toolbar-end">
      <button className="icon-button" aria-label="Git identity…" title="Repository Git identity" disabled={disabled} onClick={() => setIdentityOpen(true)}><UserRound size={16} /></button>
      <button className="icon-button refresh-button" aria-label="Refresh" title="Refresh repository" data-pending={busy} disabled={busy} onClick={onRefresh}><RefreshCw size={16} /></button>
    </div>
  </div>
    {publishOpen && <PublishDialog remotes={sync?.remotes ?? []} branch={sync?.branch ?? ''} onPublish={publish} onClose={() => setPublishOpen(false)} />}
    {identityOpen && <RepositoryIdentityDialog handle={handle} revision={revision} onApply={async (identity: CommitIdentity, expectedLocal: GitIdentityValues) => { await onWrite('repository_set_git_identity', { identity, expectedLocal }); notify('Repository Git identity updated.'); }} onClose={() => setIdentityOpen(false)} />}
  </>;
}
