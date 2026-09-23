import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, FolderGit2, GitBranch, Globe2, Tag, X } from 'lucide-react';
import { layoutHistory } from '../graph/layout';
import type { CommitSummary, HistoryPage, RepositoryLocation, RepositoryState, RepositoryStatus, SearchResult, RepositoryMutation } from '../model/repository';
import { appendUnique, errorMessage, graphCommit, native, validateHistory, WORKING_ID } from '../model/native';
import { HistoryGraph, graphDropAction, REF_DRAG_TYPE, COMMIT_DRAG_TYPE, type GraphAnchor, type GraphHandle } from './HistoryGraph';
import { NativeInspector } from './NativeInspector';
import { PaneResizer } from './WorkspaceControls';
import { DiffPreview, WorkingChanges, type ActiveDiffState } from './WorkingChanges';
import { writeAndRefresh, type MutationOutcome } from '../model/workflow';
import { remoteAndRefresh } from '../model/remoteFlow';
import type { OperationState } from '../model/operations';
import { OperationDialog, type ActionContext } from './OperationDialog';
import { ConflictEditor } from './ConflictEditor';
import { PullRequestDialog } from './PullRequestDialog';
import { RepositoryToolbar } from './RepositoryToolbar';
import { RemoteStashDialog } from './RemoteStashDialog';
import { toggleCommit } from '../model/operationUi';
import { operationAndRefresh, readOperationSnapshot } from '../model/operationFlow';
import { locationLabel, sessionKey } from '../model/tabs';
import { useSettings } from '../model/settings';

export interface RepositoryPaneProps {
  tabId: string;
  location: RepositoryLocation;
  /** False while another tab is focused. Gates keyboard shortcuts, the
   * background poll, and passive toolbar reads so a hidden pane cannot steal
   * input, race the visible pane's refresh, or make needless IPC calls. The
   * pane itself stays mounted (not unmounted) so its selection, filters,
   * scroll position, and compare/commit draft state survive the switch. */
  active: boolean;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  inspectorWidth: number;
  sidebarWidth: number;
  setInspectorWidth: (value: number) => void;
  setSidebarWidth: (value: number) => void;
  setInspectorOpen: (value: boolean) => void;
  /** Reported once the session resolves (or fails to). The container drops
   * this pane in favor of a pre-existing one when the canonical key matches
   * another open tab (same worktree root, common dir, and native/WSL origin). */
  onIdentity: (tabId: string, key: string | null, title: string | null) => void;
  onBusyChange: (tabId: string, busy: boolean) => void;
  /** Current branch name and whether the working tree has any entries, for
   * the tab strip's branch/dirty indicators. */
  onMeta: (tabId: string, branch: string | null, dirty: boolean) => void;
}

export function RepositoryPane({ tabId, location, active, sidebarOpen, inspectorOpen, inspectorWidth, sidebarWidth, setInspectorWidth, setSidebarWidth, setInspectorOpen, onIdentity, onBusyChange, onMeta }: RepositoryPaneProps) {
  const { theme, settings } = useSettings();
  const [state, setState] = useState<RepositoryState | null>(null);
  const [status, setStatus] = useState<RepositoryStatus | null>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [activeDiff, setActiveDiff] = useState<ActiveDiffState | null>(null);
  const [split, setSplit] = useState(settings.diffView === 'split');
  useEffect(() => setSplit(settings.diffView === 'split'), [settings.diffView]);
  const [mutationBusy, setMutationBusy] = useState(false);
  const mutationLock = useRef(false);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const operationFingerprint = useRef('');
  const [actionContext, setActionContext] = useState<ActionContext | null>(null);
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [prSource, setPrSource] = useState<string | null>(null);
  const [pickOrder, setPickOrder] = useState<string[]>([]);
  const [pickMode, setPickMode] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const [mutationBlocked, setMutationBlocked] = useState(false);
  const blockedRef = useRef(false);
  const [base, setBase] = useState('');
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [branch, setBranch] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [path, setPath] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchRetry, setSearchRetry] = useState(0);
  const graph = useRef<GraphHandle>(null);
  const search = useRef<HTMLInputElement>(null);
  const anchor = useRef<GraphAnchor | null>(null);
  const jumpTo = useRef<string | null>(null);
  const epoch = useRef(0);
  const lock = useRef(false);
  const session = useRef<RepositoryState | null>(null);
  const history = useRef<CommitSummary[]>([]);
  const nextCursor = useRef<string | null>(null);
  const fingerprint = useRef('');
  const generation = useRef('');
  const revealToken = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const activeRef = useRef(active);
  activeRef.current = active;
  const onIdentityRef = useRef(onIdentity);
  onIdentityRef.current = onIdentity;
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;
  useEffect(() => { onBusyChangeRef.current(tabId, mutationBusy); }, [tabId, mutationBusy]);
  useEffect(() => { onMetaRef.current(tabId, state?.session.headRef?.replace(/^refs\/heads\//, '') ?? null, !!status?.entries.length); }, [tabId, state?.session.headRef, status?.entries.length]);
  useEffect(() => { revealToken.current++; }, [selected]);
  // Tabs are never unmounted while closed via the strip (that only happens on
  // deliberate tab close), but a hidden pane's own dialogs are: switching away
  // both makes the browser force-close any open top-layer <dialog> in it
  // (ancestor `hidden` => display:none) and, independently, clears this
  // dialog-open state so the two can't drift apart. Any in-flight write
  // (operationWrite/remoteWrite) is owned by this component, not by the
  // dialog, so it keeps running and its result still lands on this tab.
  useEffect(() => { if (!active) { setActionContext(null); setConflictPath(null); setPrSource(null); setStashOpen(false); } }, [active]);
  const close = (handle: string) => native('repository_close', { handle }).catch(() => {});
  useEffect(() => () => { epoch.current++; revealToken.current++; if (session.current) void close(session.current.session.handle); session.current = null; }, []);
  function installHistory(items: CommitSummary[], next: string | null) { history.current = items; nextCursor.current = next; setCommits(items); setCursor(next); }
  const open = useCallback(async () => {
    if (mutationLock.current) return;
    const token = ++epoch.current; revealToken.current++; setBusy(true); setError(''); lock.current = true;
    const old = session.current; session.current = null; setState(null); setStatus(null); installHistory([], null); setBase(''); setTarget(''); setSelected(''); setActiveDiff(null);
    setOperation(null); setActionContext(null); setConflictPath(null); setPrSource(null); setPickOrder([]); blockedRef.current = false; setMutationBlocked(false);
    if (old) void close(old.session.handle);
    let opened: RepositoryState | null = null;
    try {
      opened = await native<RepositoryState>('repository_open', { location });
      if (token !== epoch.current) { void close(opened.session.handle); return; }
      const handle = opened.session.handle;
      const snapshot = await readOperationSnapshot(handle, { current: () => token === epoch.current });
      const activeOperation = snapshot.operation;
      if (token !== epoch.current) { void close(handle); return; }
      session.current = snapshot.state; setState(snapshot.state); setStatus(snapshot.status); fingerprint.current = snapshot.status.fingerprint; generation.current = snapshot.generation;
      setOperation(activeOperation); operationFingerprint.current = activeOperation.fingerprint;
      installHistory(snapshot.commits, snapshot.cursor); setSelected(snapshot.state.session.head ?? snapshot.commits[0]?.id ?? ''); if (!snapshot.state.session.head && snapshot.status.entries.length) { setSelected(WORKING_ID); setInspectorOpen(true); } setRevision(value => value + 1);
      onIdentityRef.current(tabId, sessionKey(location, snapshot.state.session), snapshot.state.session.name);
    } catch (e) { if (opened) void close(opened.session.handle); if (token === epoch.current) { setError(errorMessage(e)); onIdentityRef.current(tabId, null, null); } }
    finally { if (token === epoch.current) { lock.current = false; setBusy(false); } }
  }, [location, tabId]);
  useEffect(() => { void open(); }, [open]);
  const refresh = useCallback(async (force = false) => {
    const current = session.current;
    if (!current) return;
    if (!force && (lock.current || mutationLock.current)) return;
    if (force) {
      while (lock.current && session.current?.session.handle === current.session.handle) await new Promise(resolve => setTimeout(resolve, 25));
      if (session.current?.session.handle !== current.session.handle) throw new Error('Repository session changed.');
    }
    const token = epoch.current; lock.current = true;
    try {
      const handle = current.session.handle;
      const snapshot = await readOperationSnapshot(handle, {
        previous: { state: current, commits: history.current, cursor: nextCursor.current, generation: generation.current },
        preserve: [selectedRef.current, graph.current?.anchor()?.id ?? ''],
        current: () => token === epoch.current,
      });
      const activeOperation = snapshot.operation;
      if (token !== epoch.current) return;
      const operationChanged = operationFingerprint.current !== activeOperation.fingerprint;
      operationFingerprint.current = activeOperation.fingerprint;
      setOperation(previous => previous?.fingerprint === activeOperation.fingerprint ? previous : activeOperation);
      const { state: updated, status: working } = snapshot;
      const changed = updated.fingerprint !== current.fingerprint;
      const workingChanged = working.fingerprint !== fingerprint.current;
      if (changed) {
        anchor.current = graph.current?.anchor() ?? null;
        generation.current = snapshot.generation;
        installHistory(snapshot.commits, snapshot.cursor);
      }
      if (workingChanged && !anchor.current) anchor.current = graph.current?.anchor() ?? null;
      session.current = updated;
      if (changed || force) setState(updated);
      if (changed || workingChanged || force) setStatus(working);
      fingerprint.current = working.fingerprint;
      if (changed || workingChanged || operationChanged || force) setRevision(value => value + 1);
      setError('');
      blockedRef.current = false; setMutationBlocked(false);
    } catch (e) { if (token === epoch.current) setError(errorMessage(e)); if (force) throw e; }
    finally { if (token === epoch.current) lock.current = false; }
  }, []);
  // Refresh once when this tab becomes the active one again: the background
  // poll and focus listener are both gated on `active` below, so a tab left
  // open in the background can otherwise show stale ahead/behind, refs, and
  // operation state until the next successful write happens in it.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) void refresh();
    wasActive.current = active;
  }, [active, refresh]);
  async function mutate(mutation: RepositoryMutation): Promise<MutationOutcome> {
    const current = session.current;
    if (!current || mutationLock.current || blockedRef.current) return { error: 'Repository mutations are blocked. Wait for the operation or refresh successfully.' };
    mutationLock.current = true; setMutationBusy(true);
    const token = epoch.current;
    const isCurrent = () => token === epoch.current && session.current?.session.handle === current.session.handle;
    try {
      // Let an already-running read finish, then exclude polling/paging until the
      // write AND its required refresh complete. No dropped post-write reloads.
      while (lock.current && isCurrent()) await new Promise(resolve => setTimeout(resolve, 25));
      const outcome = await writeAndRefresh(current.session.handle, mutation, () => refresh(true), isCurrent);
      if (outcome.refreshError && isCurrent()) { blockedRef.current = true; setMutationBlocked(true); }
      return outcome;
    } finally { if (isCurrent()) { mutationLock.current = false; setMutationBusy(false); } }
  }
  async function operationWrite(command: string, args: Record<string, unknown>) {
    const current = session.current;
    if (!current || mutationLock.current || blockedRef.current) throw new Error('Repository mutations are blocked. Refresh successfully before retrying.');
    const token = epoch.current;
    const isCurrent = () => epoch.current === token && session.current?.session.handle === current.session.handle;
    mutationLock.current = true; setMutationBusy(true);
    try {
      while (lock.current && isCurrent()) await new Promise(resolve => setTimeout(resolve, 25));
      if (!isCurrent()) throw new Error('Repository session changed.');
      const outcome = await operationAndRefresh(current.session.handle, command, args, () => refresh(true), isCurrent);
      if (outcome.superseded) throw new Error('Repository session changed.');
      if (outcome.refreshError) { blockedRef.current = true; setMutationBlocked(true); }
      if (outcome.error || outcome.refreshError) throw new Error([outcome.error, outcome.refreshError && `Refresh failed: ${outcome.refreshError}. Further writes are blocked until refresh succeeds.`].filter(Boolean).join('\n'));
    } finally { if (isCurrent()) { mutationLock.current = false; setMutationBusy(false); } }
  }
  /** Same write+refresh lifecycle as `operationWrite`, for the remote/stash
   * IPC contract, which returns human-readable `output` text bound to this
   * tab (never a global toast) instead of a void result. */
  async function remoteWrite(command: string, args: Record<string, unknown>): Promise<string> {
    const current = session.current;
    if (!current || mutationLock.current || blockedRef.current) throw new Error('Repository mutations are blocked. Refresh successfully before retrying.');
    const token = epoch.current;
    const isCurrent = () => epoch.current === token && session.current?.session.handle === current.session.handle;
    mutationLock.current = true; setMutationBusy(true); setActionError('');
    try {
      while (lock.current && isCurrent()) await new Promise(resolve => setTimeout(resolve, 25));
      if (!isCurrent()) throw new Error('Repository session changed.');
      const outcome = await remoteAndRefresh(current.session.handle, command, args, () => refresh(true), isCurrent);
      if (outcome.superseded) throw new Error('Repository session changed.');
      if (outcome.refreshError) { blockedRef.current = true; setMutationBlocked(true); }
      if (outcome.error || outcome.refreshError) throw new Error([outcome.error, outcome.refreshError && `Refresh failed: ${outcome.refreshError}. Further writes are blocked until refresh succeeds.`].filter(Boolean).join('\n'));
      return outcome.output ?? '';
    } catch (e) {
      // A stash/publish dialog can close while its write continues. Keep errors
      // on the originating pane even after that dialog has been unmounted.
      if (isCurrent()) setActionError(errorMessage(e));
      throw e;
    } finally { if (isCurrent()) { mutationLock.current = false; setMutationBusy(false); } }
  }
  const remoteWriteRef = useRef(remoteWrite);
  remoteWriteRef.current = remoteWrite;
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && activeRef.current) void refresh(); }, 5000);
    const fetchTimer = setInterval(() => {
      if (!document.hidden && activeRef.current && session.current?.remotes.length && !lock.current && !mutationLock.current && !blockedRef.current) {
        void remoteWriteRef.current('repository_remote_action', { action: { kind: 'backgroundFetch' } }).catch(() => {});
      }
    }, 5 * 60 * 1000);
    const focus = () => { if (activeRef.current) void refresh(); };
    window.addEventListener('focus', focus);
    return () => { clearInterval(timer); clearInterval(fetchTimer); window.removeEventListener('focus', focus); };
  }, [refresh]);
  async function load(reveal?: string) {
    if (!session.current || lock.current || mutationLock.current) return;
    const token = epoch.current; const request = ++revealToken.current; lock.current = true; setBusy(true); setError('');
    try {
      let items = history.current;
      while (nextCursor.current && (!reveal || !items.some(commit => commit.id === reveal))) {
        const page = await native<HistoryPage>('repository_history', { handle: session.current.session.handle, cursor: nextCursor.current, limit: 200, query: {} });
        if (token !== epoch.current) return;
        if (page.generation !== generation.current) throw new Error('History changed while paging. Refresh to load a consistent history.');
        if (page.cursor === nextCursor.current) throw new Error('History cursor did not advance. Refresh and retry.');
        items = appendUnique(items, page.commits); validateHistory(items); installHistory(items, page.cursor);
        if (request !== revealToken.current) return;
        if (!reveal) break;
      }
      if (reveal) {
        if (items.some(commit => commit.id === reveal)) { setSelected(reveal); jumpTo.current = reveal; setCommits([...items]); }
        else setNotice(`Commit ${reveal.slice(0, 12)} is outside available history${session.current.session.shallow ? ' (shallow boundary)' : ''}.`);
      }
    } catch (e) { if (token === epoch.current) setError(errorMessage(e)); }
    finally { if (token === epoch.current) { lock.current = false; setBusy(false); } }
  }
  function reveal(id: string) {
    setNotice('');
    setActiveDiff(null);
    if (id === WORKING_ID) {
      setSelected(WORKING_ID);
      setInspectorOpen(true);
      return;
    }
    if (history.current.some(commit => commit.id === id)) {
      setSelected(id);
      jumpTo.current = id;
      setCommits(items => [...items]);
    } else {
      void load(id);
    }
  }
  const graphCommits = useMemo(() => {
    const list = commits.map(graphCommit);
    // Never attach live working status to a different pinned HEAD.
    if (status?.entries.length && status.head === state?.session.head && status.headRef === state?.session.headRef) list.unshift(graphCommit({ id: WORKING_ID, parents: status.head ? [status.head] : [], subject: `Working changes · ${status.entries.length} paths`, author: 'Working tree', email: '', timestamp: 0 }));
    return list;
  }, [commits, status, state?.session.head, state?.session.headRef]);
  const layout = useMemo(() => layoutHistory(graphCommits), [graphCommits]);
  useLayoutEffect(() => { if (anchor.current) { graph.current?.restore(anchor.current); anchor.current = null; } if (jumpTo.current) { const row = graphCommits.findIndex(commit => commit.id === jumpTo.current); if (row >= 0) { graph.current?.scrollTo(row); jumpTo.current = null; } } }, [graphCommits]);
  const filtering = !!(text || branch || since || until || path);
  useEffect(() => {
    let live = true; setResult(null); setSearchError(''); setSearchBusy(filtering && !!state);
    if (!state || !filtering) return;
    const timer = setTimeout(() => { native<SearchResult>('repository_search', { handle: state.session.handle, query: { text, ...(branch ? { branch } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}), ...(path ? { path } : {}) } })
      .then(value => { if (live) setResult(value); }).catch(e => { if (live) setSearchError(errorMessage(e)); }).finally(() => { if (live) setSearchBusy(false); }); }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [state?.session.handle, text, branch, since, until, path, filtering, revision, searchRetry]);
  const matches = useMemo(() => result ? new Set(result.commits.map(commit => commit.id)) : null, [result]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (document.querySelector('dialog[open]')) return;
      const editable = event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
      if ((event.key === '/' && !editable) || ((event.metaKey || event.ctrlKey) && event.key === 'k')) { event.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, []);
  return <>
    {state && <RepositoryToolbar handle={state.session.handle} active={active} revision={revision} busy={mutationBusy || mutationBlocked} pickCount={pickOrder.length} pickMode={pickMode}
      onCreateBranch={() => setActionContext({ oid: state.session.head ?? '', ref: state.session.headRef ?? undefined, initial: 'createBranch' })}
      onSwitchBranch={() => setActionContext({ oid: state.session.head ?? '', initial: 'switchBranch' })}
      onCherryPick={() => setActionContext({ oid: pickOrder[0], commits: pickOrder, initial: 'cherryPick' })}
      onClearPick={() => { setPickMode(false); setPickOrder([]); }}
      onStartPickMode={() => setPickMode(true)}
      onOpenStash={() => setStashOpen(true)}
      onRefresh={() => void refresh()}
      onWrite={remoteWrite}
      notify={setNotice} />}
    {actionError && <div className="native-banner" role="alert">{actionError} <button onClick={() => setActionError('')}>Dismiss operation error</button></div>}
    {error && <div className="native-banner" role="alert">{error} <button disabled={busy} onClick={() => state ? void refresh() : void open()}>Retry</button></div>}
    {busy && !state && <div className="native-banner" role="status">Opening {locationLabel(location)}…</div>}{notice && <div className="native-banner" role="status">{notice}</div>}
    {mutationBlocked && <div className="operation-banner" role="alert">Refresh failed after a write. Further writes are blocked until a successful refresh.<button onClick={() => void refresh()}>Refresh now</button></div>}
    {state && operation && (operation.kind !== 'none' || !!operation.conflicts.length) && <div className="operation-banner" role="status"><strong>{operation.label || operation.kind}</strong><span>{operation.current} {operation.incoming && `← ${operation.incoming}`}{operation.step !== null && ` · Step ${operation.step}${operation.total !== null ? ` / ${operation.total}` : ''}`}</span>{(['continue', 'skip', 'abort'] as const).map(kind => <button key={kind} disabled={mutationBusy || mutationBlocked || operation.kind === 'unsupported' || (kind === 'continue' && !operation.canContinue) || (kind === 'skip' && !operation.canSkip)} onClick={() => setActionContext({ oid: state.session.head ?? '', initial: kind })}>{kind === 'continue' ? 'Continue' : kind === 'skip' ? 'Skip' : 'Abort'}</button>)}{operation.conflicts.map(path => <button key={path} onClick={() => setConflictPath(path)}>Resolve {path}</button>)}</div>}
    {state && selected && selected !== WORKING_ID && !commits.some(commit => commit.id === selected) && <div className="native-banner" role="status">Selected commit {selected.slice(0, 12)} is {cursor ? 'outside the loaded history' : 'no longer reachable from the current references'}. Its inspector remains open by object ID.{cursor && <button disabled={busy} onClick={() => reveal(selected)}>Reveal selected commit</button>}</div>}
    {!state ? <main className="native-welcome"><span className="eyebrow">OPENING REPOSITORY</span><h1>{locationLabel(location)}</h1><p>{error ? 'This repository could not be opened. Use Retry above once the problem is resolved.' : 'Reading repository state…'}</p></main> : <main className="workspace">
      {sidebarOpen && <><aside className="sidebar native-sidebar" aria-label="Repository references"><div className="workspace-label"><FolderGit2 size={22} /><span>{state.session.name}<small>{state.session.location.kind === 'wsl' ? state.session.location.distribution : 'Local repository'}</small></span></div><div className="sidebar-divider" />{(['local', 'remote', 'tag'] as const).map(kind => { const refs = state.refs.filter(ref => ref.kind === kind); const Icon = kind === 'tag' ? Tag : kind === 'remote' ? Globe2 : GitBranch; return <details className="reference-group" key={kind} open={kind === 'local'}><summary>{kind === 'local' ? 'Branches' : kind === 'remote' ? 'Remote branches' : 'Tags'}<span className="count">{refs.length}</span></summary>{refs.map(ref => <div className="ref-action-row" key={ref.fullName} onContextMenu={event => { event.preventDefault(); setActionContext({ oid: ref.commitId, ref: ref.fullName }); }}><button className="ref-item" title={ref.fullName} disabled={busy} draggable={ref.kind !== 'tag'}
        onDragStart={event => { event.stopPropagation(); if (ref.kind === 'tag') { event.preventDefault(); return; } event.dataTransfer.clearData(COMMIT_DRAG_TYPE); event.dataTransfer.setData(REF_DRAG_TYPE, ref.fullName); event.dataTransfer.effectAllowed = 'copy'; }}
        onDragOver={event => { if (ref.fullName === state.session.headRef && [REF_DRAG_TYPE, COMMIT_DRAG_TYPE].some(type => event.dataTransfer.types.includes(type))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); const action = graphDropAction(event.dataTransfer, ref.fullName, state.session.headRef, commits, state.refs); if (action) setActionContext(action); }}
        onClick={() => reveal(ref.commitId)} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setActionContext({ oid: ref.commitId, ref: ref.fullName }); } }}><Icon size={15} /><span>{ref.name}</span>{ref.fullName === state.session.headRef && <span className="current-branch-dot" />}</button><button aria-label={`Actions for ${ref.name}`} onClick={() => setActionContext({ oid: ref.commitId, ref: ref.fullName })}>…</button></div>)}{!refs.length && <p className="empty-category">No references</p>}</details>; })}{state.remotes.length > 0 && <details className="reference-group"><summary>Remotes<span className="count">{state.remotes.length}</span></summary>{state.remotes.map(remote => <p key={remote}>{remote}</p>)}</details>}<div className="sidebar-bottom"><span className="eyebrow">LOCAL FIRST</span><p>Repository data stays on your machine.</p></div></aside><PaneResizer label="Resize repository sidebar" width={sidebarWidth} onChange={setSidebarWidth} min={210} max={340} direction={1} /></>}
      <div className="workspace-main">
        <div className="history-workspace">
          {activeDiff ? (
            <section className="diff-view-pane" aria-label={`Diff for ${activeDiff.path}`}>
              <div className="diff-view-header">
                <div className="diff-view-file">
                  <FileCode2 size={16} />
                  <span className="diff-view-filepath">{activeDiff.path}</span>
                  {activeDiff.group && <span className={`diff-view-group-badge ${activeDiff.group}`}>{activeDiff.group}</span>}
                </div>
                <div className="diff-view-actions">
                  {activeDiff.onToggleStage && (
                    <button className={`secondary-button diff-stage-btn ${activeDiff.isStaged ? 'unstage' : 'stage'}`} disabled={mutationBusy || mutationBlocked} onClick={activeDiff.onToggleStage}>
                      {activeDiff.isStaged ? 'Unstage File' : 'Stage File'}
                    </button>
                  )}
                  <button className="secondary-button" aria-pressed={split} onClick={() => setSplit(!split)}>
                    {split ? 'Unified' : 'Side by side'}
                  </button>
                  <button className="icon-button" aria-label="Close diff and show tree" title="Close diff" onClick={() => setActiveDiff(null)}>
                    <X size={17} />
                  </button>
                </div>
              </div>
              <div className="diff-view-body">
                {activeDiff.loading && <p className="diff-placeholder" role="status">Loading diff…</p>}
                {activeDiff.error && <p className="workflow-alert error" role="alert">{activeDiff.error}</p>}
                {activeDiff.diff && (
                  <DiffPreview
                    diff={activeDiff.diff}
                    split={split}
                    hunkAction={activeDiff.hunkAction}
                    busy={mutationBusy || mutationBlocked}
                    onHunk={activeDiff.onHunk}
                  />
                )}
              </div>
            </section>
          ) : (
            <section className="history-pane" aria-label="Repository history">
              <div className="repository-heading"><div><span className="eyebrow">REPOSITORY / {state.session.name}</span><h1>History</h1><p>{state.session.root}</p></div><span className="local-badge">{state.session.location.kind === 'wsl' ? `WSL · ${state.session.location.distribution}` : 'LOCAL'}</span></div><div className="native-repo-meta"><GitBranch size={15} />{state.session.headRef?.replace('refs/heads/', '') ?? 'Detached / unborn HEAD'}{state.session.linkedWorktree && ' · Linked worktree'}{state.session.bare && ' · Bare repository'}{state.session.shallow && ' · Shallow clone'}</div>
              <div className="native-filters"><div className="filter-primary"><input ref={search} aria-label="Search full history" placeholder="Search messages, authors, hashes…" value={text} onChange={e => setText(e.target.value)} /><select aria-label="Branch scope" value={branch} onChange={e => setBranch(e.target.value)}><option value="">All branches</option>{state.refs.map(ref => <option key={ref.fullName} value={ref.fullName}>{ref.name}</option>)}</select><button disabled={busy || !state.session.head} onClick={() => state.session.head && reveal(state.session.head)}>HEAD</button></div><div className="filter-secondary"><details><summary>Date &amp; path{(since || until || path) && <span className="count">Active</span>}</summary><div className="filter-disclosure"><label>Since <input type="date" value={since} onChange={e => setSince(e.target.value)} /></label><label>Until <input type="date" value={until} onChange={e => setUntil(e.target.value)} /></label><label className="path-filter">Path <input aria-label="Filter path" placeholder="src/components/" value={path} onChange={e => setPath(e.target.value)} /></label></div></details>{filtering && <button className="text-button" onClick={() => { setText(''); setBranch(''); setSince(''); setUntil(''); setPath(''); }}>Clear filters</button>}</div></div>
              {filtering && <div className="native-search-results"><p role="status">{searchBusy ? 'Searching full history…' : `${result?.commits.length ?? 0} matches${result?.truncated ? ' · Results truncated; narrow the query' : ''}`} · Ancestry preserved</p>{searchError && <p role="alert">{searchError} <button onClick={() => setSearchRetry(value => value + 1)}>Retry search</button></p>}<div>{result?.commits.map(commit => <button key={commit.id} disabled={busy} onClick={() => reveal(commit.id)}>{commit.id.slice(0, 7)} {commit.subject}</button>)}</div></div>}
              {!graphCommits.length && <p className="native-banner">This repository has no commits or working changes.</p>}
              <HistoryGraph ref={graph} commits={graphCommits} layout={layout} refs={state.refs} selectedId={selected} head={state.session.head ?? ''} headRef={state.session.headRef} onActions={context => setActionContext(context)} pickOrder={pickOrder} onTogglePick={pickMode ? id => setPickOrder(order => toggleCommit(order, id)) : undefined} loaded={graphCommits.length} matches={matches} onSelect={id => reveal(id)} onLoadMore={() => void load()} onOpenDetails={() => setInspectorOpen(true)} theme={theme} hasMore={!!cursor} paging={busy} shallow={state.session.shallow} />
              <div className="native-repo-meta">{cursor ? 'Unloaded ancestry continues below. Load older history to reveal parents.' : state.session.shallow ? 'Shallow boundary: earlier ancestry is unavailable locally.' : 'End of available history.'}</div>
            </section>
          )}
          {inspectorOpen && <>
            <PaneResizer label="Resize inspector" width={inspectorWidth} onChange={setInspectorWidth} min={280} max={640} />
            {selected === WORKING_ID || (!selected && (status?.entries.length ?? 0) > 0) ? (
              <aside className="working-inspector-sidebar" style={{ width: `${inspectorWidth}px` }}>
                <WorkingChanges
                  key={state.session.handle}
                  session={state.session}
                  status={status}
                  revision={revision}
                  busy={mutationBusy}
                  mutationBlocked={mutationBlocked}
                  onMutation={mutate}
                  onRefresh={() => refresh(true)}
                  onResolve={setConflictPath}
                  sidebarMode
                  activePath={activeDiff?.path ?? null}
                  onActiveDiffChange={setActiveDiff}
                  onClose={() => setInspectorOpen(false)}
                />
              </aside>
            ) : (
              <NativeInspector
                key={state.session.handle}
                session={state.session}
                selected={selected}
                status={status}
                revision={revision}
                base={base}
                target={target}
                onJump={reveal}
                onBase={() => setBase(selected)}
                onTarget={() => setTarget(selected)}
                onSwap={() => { setBase(target); setTarget(base); }}
                onClear={() => { setBase(''); setTarget(''); }}
                onClose={() => setInspectorOpen(false)}
                activePath={activeDiff?.path ?? null}
                onActiveDiffChange={setActiveDiff}
              />
            )}
          </>}
        </div>
      </div>
    </main>}
    <footer className="statusbar"><span><span className="live-dot" />{mutationBusy ? 'Updating repository…' : 'Local workspace · automatic refresh'}</span><span>{state ? `${commits.length} commits loaded` : 'No repository open'}</span></footer>
    {state && actionContext && <OperationDialog key={state.session.handle} state={state} operation={operation} context={actionContext} commits={commits} busy={mutationBusy || mutationBlocked} onWrite={operationWrite} onClose={() => setActionContext(null)} onCompare={source => { setBase(state.session.head ?? ''); setTarget(source); setInspectorOpen(true); setActionContext(null); }} onPullRequest={source => { setPrSource(source); setActionContext(null); }} />}
    {state && conflictPath && <ConflictEditor key={`${state.session.handle}:${conflictPath}`} handle={state.session.handle} path={conflictPath} revision={revision} busy={mutationBusy || mutationBlocked} onWrite={operationWrite} onClose={() => setConflictPath(null)} />}
    {state && prSource && <PullRequestDialog key={state.session.handle} handle={state.session.handle} source={prSource} onClose={() => setPrSource(null)} />}
    {state && stashOpen && <RemoteStashDialog key={`${state.session.handle}:stash`} handle={state.session.handle} onWrite={remoteWrite} onClose={() => setStashOpen(false)} notify={setNotice} />}
  </>;
}
