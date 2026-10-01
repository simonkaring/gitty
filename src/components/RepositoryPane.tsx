import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, Copy, Download, FileCode2, FileDiff, GitBranch, GitBranchPlus, GitCommitHorizontal, Globe2, Laptop, LocateFixed, RefreshCw, Search, Tag, Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import { useGraphLayout } from '../graph/useGraphLayout';
import type { CommitSummary, HistoryPage, RepositoryLocation, RepositoryState, RepositoryStatus, SearchResult, RepositoryMutation } from '../model/repository';
import { appendUnique, errorMessage, graphCommit, isDemoHandle, native, validateHistory, WORKING_ID } from '../model/native';
import { HistoryGraph, type GraphAnchor, type GraphHandle } from './HistoryGraph';
import { NativeInspector } from './NativeInspector';
import { NativeSidebar } from './NativeSidebar';
import { PaneResizer } from './WorkspaceControls';
import { DiffPreview, WorkingChanges, type ActiveDiffState } from './WorkingChanges';
import { writeAndRefresh, type MutationOutcome } from '../model/workflow';
import { remoteAndRefresh } from '../model/remoteFlow';
import type { OperationState } from '../model/operations';
import { OperationDialog, type ActionContext } from './OperationDialog';
import { GraphContextMenu, type MenuTarget } from './GraphContextMenu';
import { ConflictEditor } from './ConflictEditor';
import { PullRequestDialog } from './PullRequestDialog';
import { RepositoryToolbar } from './RepositoryToolbar';
import { PublishDialog } from './PublishDialog';
import { RemoteStashDialog } from './RemoteStashDialog';
import { toggleCommit } from '../model/operationUi';
import { captureOperation, operationAndRefresh, readOperationSnapshot } from '../model/operationFlow';
import { SwitchBlockedDialog } from './SwitchBlockedDialog';
import { Segmented, Toast } from './ui';
import { locationLabel, sessionKey } from '../model/tabs';
import { useSettings } from '../model/settings';
import { SCALES, applyScale, loadScale } from '../model/scale';
import { AUTO_FETCH_CHECK, autoFetchDue, isFetchingAction, type FetchStatus } from '../model/autoFetch';
import { DEFAULT_PULL_MODE, describeRemoteAction, needsPublish, type RemoteActionRequest, type SyncInfo } from '../model/remote';

const GROUP_TONE = { staged: 'green', unstaged: 'amber', untracked: 'accent', conflict: 'red' } as const;

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
  /** Command palette is owned by the workspace; the active pane adds repository commands. */
  paletteOpen?: boolean;
  onClosePalette?: () => void;
  workspaceCommands?: PaletteCommand[];
}

export function RepositoryPane({ paletteOpen = false, onClosePalette = () => {}, workspaceCommands = [], tabId, location, active, sidebarOpen, inspectorOpen, inspectorWidth, sidebarWidth, setInspectorWidth, setSidebarWidth, setInspectorOpen, onIdentity, onBusyChange, onMeta }: RepositoryPaneProps) {
  const { theme, settings } = useSettings();
  const [scale, setScale] = useState(loadScale);
  const changeScale = (next: number) => { setScale(next); applyScale(next); };
  const stepScale = (dir: number) => changeScale(SCALES[Math.min(SCALES.length - 1, Math.max(0, SCALES.indexOf(scale as typeof SCALES[number]) + dir))]);
  const [state, setState] = useState<RepositoryState | null>(null);
  const [status, setStatus] = useState<RepositoryStatus | null>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  // Notices are transient toasts; errors stay until dismissed.
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  const [revision, setRevision] = useState(0);
  const [activeDiff, setActiveDiff] = useState<ActiveDiffState | null>(null);
  const [split, setSplit] = useState(settings.diffView === 'split');
  useEffect(() => setSplit(settings.diffView === 'split'), [settings.diffView]);
  const [mutationBusy, setMutationBusy] = useState(false);
  const mutationLock = useRef(false);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const operationFingerprint = useRef('');
  const [actionContext, setActionContext] = useState<ActionContext | null>(null);
  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null);
  const [publishInfo, setPublishInfo] = useState<SyncInfo | null>(null);
  const [blockedSwitch, setBlockedSwitch] = useState<{ branch: string; ref: string; oid: string; reason: string } | null>(null);
  const switchPending = useRef(false);
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [prSource, setPrSource] = useState<string | null>(null);
  const [pickOrder, setPickOrder] = useState<string[]>([]);
  const [pickMode, setPickMode] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const [mutationBlocked, setMutationBlocked] = useState(false);
  const blockedRef = useRef(false);
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>({ kind: 'idle' });
  const lastFetchAttempt = useRef<number | null>(null);
  const autoFetchRef = useRef<() => void>(() => {});
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
  useEffect(() => { if (!active) { setActionContext(null); setMenuTarget(null); setPublishInfo(null); setBlockedSwitch(null); setConflictPath(null); setPrSource(null); setStashOpen(false); } }, [active]);
  const close = (handle: string) => native('repository_close', { handle }).catch(() => {});
  useEffect(() => () => { epoch.current++; revealToken.current++; if (session.current) void close(session.current.session.handle); session.current = null; }, []);
  function installHistory(items: CommitSummary[], next: string | null) { history.current = items; nextCursor.current = next; setCommits(items); setCursor(next); }
  const open = useCallback(async () => {
    if (mutationLock.current) return;
    const token = ++epoch.current; revealToken.current++; setBusy(true); setError(''); lock.current = true;
    const old = session.current; session.current = null; setState(null); setStatus(null); installHistory([], null); setBase(''); setTarget(''); setSelected(''); setActiveDiff(null);
    setOperation(null); setActionContext(null); setMenuTarget(null); setPublishInfo(null); setConflictPath(null); setPrSource(null); setPickOrder([]); blockedRef.current = false; setMutationBlocked(false);
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
    if (active && !wasActive.current) void refresh().then(() => autoFetchRef.current());
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
  async function switchBranch(ref: string) {
    const current = session.current;
    const target = current?.refs.find(item => item.kind === 'local' && item.fullName === ref);
    if (!current || !target || ref === current.session.headRef || switchPending.current) return;
    if (mutationLock.current || blockedRef.current) { setBlockedSwitch({ branch: target.name, ref, oid: target.commitId, reason: blockedRef.current ? 'Refresh the repository before another write.' : 'Another repository operation is running. Wait for it to finish.' }); return; }
    switchPending.current = true;
    const token = epoch.current;
    try {
      // Working changes travel with the switch; overlapping ones become conflicts for the editor.
      const request = await captureOperation(current.session.handle, { kind: 'switchBranch', branch: ref, carryChanges: true });
      if (epoch.current !== token || session.current?.session.handle !== current.session.handle) return;
      await operationWrite('repository_run_operation', { request });
      if (epoch.current !== token) return;
      const after = await native<OperationState>('repository_operation_state', { handle: current.session.handle });
      if (epoch.current !== token) return;
      if (after.conflicts.length) { setNotice(`Switched to ${target.name} with conflicts to resolve.`); setConflictPath(after.conflicts[0]); }
      else setNotice(`Switched to ${target.name}.`);
    } catch (error) {
      if (epoch.current === token) setBlockedSwitch({ branch: target.name, ref, oid: target.commitId, reason: errorMessage(error) });
    } finally { switchPending.current = false; }
  }
  /** Same write+refresh lifecycle as `operationWrite`, for the remote/stash
   * IPC contract, which returns human-readable `output` text bound to this
   * tab (never a global toast) instead of a void result. */
  async function remoteWrite(command: string, args: Record<string, unknown>, options: { quiet?: boolean } = {}): Promise<string> {
    const current = session.current;
    if (!current || mutationLock.current || blockedRef.current) throw new Error('Repository mutations are blocked. Refresh successfully before retrying.');
    const token = epoch.current;
    const isCurrent = () => epoch.current === token && session.current?.session.handle === current.session.handle;
    const kind = (args.action as { kind?: string } | undefined)?.kind;
    const fetching = command === 'repository_remote_action' && isFetchingAction(args.action);
    // Background fetch only moves remote-tracking refs: it must not block local writes such as switching branches.
    const holdsLock = !options.quiet;
    if (holdsLock) { mutationLock.current = true; setMutationBusy(true); }
    // Background fetch reports through the toolbar's fetch status instead of
    // clearing or replacing an error banner the user has not dismissed yet.
    if (!options.quiet) setActionError('');
    if (fetching) { lastFetchAttempt.current = Date.now(); setFetchStatus({ kind: 'fetching', since: Date.now() }); }
    try {
      while (lock.current && isCurrent()) await new Promise(resolve => setTimeout(resolve, 25));
      if (!isCurrent()) throw new Error('Repository session changed.');
      const outcome = await remoteAndRefresh(current.session.handle, command, args, () => refresh(true), isCurrent);
      if (outcome.superseded) throw new Error('Repository session changed.');
      if (fetching && isCurrent()) {
        // A failed pull may have fetched and then refused to integrate; only a
        // failed fetch is a fetch failure.
        if (!outcome.error) setFetchStatus({ kind: 'fetched', at: Date.now() });
        else if (kind !== 'pull') setFetchStatus({ kind: 'failed', at: Date.now(), message: outcome.error });
        else setFetchStatus(previous => previous.kind === 'fetching' ? { kind: 'idle' } : previous);
      }
      if (outcome.refreshError) { blockedRef.current = true; setMutationBlocked(true); }
      if (outcome.error || outcome.refreshError) throw new Error([outcome.error, outcome.refreshError && `Refresh failed: ${outcome.refreshError}. Further writes are blocked until refresh succeeds.`].filter(Boolean).join('\n'));
      return outcome.output ?? '';
    } catch (e) {
      // A stash/publish dialog can close while its write continues. Keep errors
      // on the originating pane even after that dialog has been unmounted.
      if (isCurrent()) {
        if (!options.quiet) setActionError(errorMessage(e));
        if (fetching) setFetchStatus(previous => previous.kind === 'fetching' ? { kind: 'failed', at: Date.now(), message: errorMessage(e) } : previous);
      }
      throw e;
    } finally { if (holdsLock && isCurrent()) { mutationLock.current = false; setMutationBusy(false); } }
  }
  const remoteWriteRef = useRef(remoteWrite);
  remoteWriteRef.current = remoteWrite;
  /** Fetches the focused tab's remote when due. Never runs for a hidden tab or
   * window, and skips (rather than queues behind) any read or write in flight;
   * the periodic check retries shortly afterwards. */
  const autoFetch = useCallback(() => {
    if (document.hidden || !activeRef.current || !session.current?.remotes.length) return;
    if (lock.current || mutationLock.current || blockedRef.current) return;
    if (!autoFetchDue(lastFetchAttempt.current, Date.now())) return;
    void remoteWriteRef.current('repository_remote_action', { action: { kind: 'backgroundFetch' } }, { quiet: true }).catch(() => {});
  }, []);
  autoFetchRef.current = autoFetch;
  const handle = state?.session.handle;
  useEffect(() => {
    lastFetchAttempt.current = null; setFetchStatus({ kind: 'idle' });
    if (handle) autoFetch();
  }, [handle, autoFetch]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && activeRef.current) void refresh(); }, 5000);
    const fetchTimer = setInterval(autoFetch, AUTO_FETCH_CHECK);
    const focus = () => { if (activeRef.current) void refresh().then(autoFetch); };
    window.addEventListener('focus', focus);
    return () => { clearInterval(timer); clearInterval(fetchTimer); window.removeEventListener('focus', focus); };
  }, [refresh, autoFetch]);
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
  const { layout, count: layoutCount } = useGraphLayout(graphCommits);
  useLayoutEffect(() => { if (anchor.current && graphCommits.slice(0, layoutCount).some(commit => commit.id === anchor.current?.id)) { graph.current?.restore(anchor.current); anchor.current = null; } if (jumpTo.current) { const row = graphCommits.slice(0, layoutCount).findIndex(commit => commit.id === jumpTo.current); if (row >= 0) { graph.current?.scrollTo(row); jumpTo.current = null; } } }, [graphCommits, layoutCount]);
  const filtering = !!(text || branch || since || until || path);
  useEffect(() => {
    let live = true; setResult(null); setSearchError(''); setSearchBusy(filtering && !!state);
    if (!state || !filtering) return;
    const timer = setTimeout(() => { native<SearchResult>('repository_search', { handle: state.session.handle, query: { text, ...(branch ? { branch } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}), ...(path ? { path } : {}) } })
      .then(value => { if (live) setResult(value); }).catch(e => { if (live) setSearchError(errorMessage(e)); }).finally(() => { if (live) setSearchBusy(false); }); }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [state?.session.handle, text, branch, since, until, path, filtering, revision, searchRetry]);
  const matches = useMemo(() => result ? new Set(result.commits.map(commit => commit.id)) : null, [result]);
  function openMenu(context: ActionContext, x: number, y: number, trigger: HTMLElement) { setMenuTarget({ context, x, y, trigger }); }
  function compareWithCurrent(oid: string) { setBase(state?.session.head ?? ''); setTarget(oid); setInspectorOpen(true); setMenuTarget(null); setActionContext(null); }
  function setComparison(oid: string, side: 'base' | 'target') { (side === 'base' ? setBase : setTarget)(oid); reveal(oid); setInspectorOpen(true); setMenuTarget(null); }
  async function copyMenuValue(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} copied`); }
    catch { setActionError('Clipboard unavailable. Copy the text manually instead.'); }
    setMenuTarget(null);
  }
  async function runMenuRemote(action: RemoteActionRequest) {
    setMenuTarget(null);
    try { const output = await remoteWrite('repository_remote_action', { action }); setNotice(output || `${describeRemoteAction(action)} complete.`); }
    catch (e) { setActionError(errorMessage(e)); }
  }
  async function pushFromMenu(ref: string) {
    setMenuTarget(null);
    const current = session.current;
    if (!current) return;
    try {
      const info = await native<SyncInfo>('repository_sync_info', { handle: current.session.handle });
      if (session.current !== current || current.session.headRef !== ref || info.branch !== ref.replace(/^refs\/heads\//, '')) throw new Error('Branch changed. Open its menu again before pushing.');
      if (needsPublish(info)) setPublishInfo(info);
      else await runMenuRemote({ kind: 'push' });
    } catch (e) { setActionError(errorMessage(e)); }
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (document.querySelector('dialog[open]')) return;
      const editable = event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
      if (event.key === '/' && !editable) { event.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, []);
  const filters = <div className="native-filters">
    <div className="filter-primary">
      <div className="search-field">
        <Search size={14} aria-hidden="true" />
        <input ref={search} aria-label="Search full history" placeholder="Search commits…" value={text} onChange={event => setText(event.target.value)} />
        {text ? <button className="icon-button sm" aria-label="Clear search" onClick={() => setText('')}><X size={13} /></button> : <kbd>/</kbd>}
      </div>
      <select aria-label="Branch scope" title={branch ? state?.refs.find(ref => ref.fullName === branch)?.name ?? branch : 'All branches'} value={branch} onChange={event => setBranch(event.target.value)}>
        <option value="">All branches</option>
        {state?.refs.map(ref => <option key={ref.fullName} value={ref.fullName}>{ref.name}</option>)}
      </select>
      <button className="head-button" title="Jump to HEAD" disabled={busy || !state?.session.head} onClick={() => state?.session.head && reveal(state.session.head)}><LocateFixed size={15} />HEAD</button>
    </div>
    <div className="filter-secondary">
      <details><summary>Date &amp; path{(since || until || path) && <span className="count">Active</span>}</summary>
        <div className="filter-disclosure">
          <label>Since <input type="date" value={since} onChange={event => setSince(event.target.value)} /></label>
          <label>Until <input type="date" value={until} onChange={event => setUntil(event.target.value)} /></label>
          <label className="path-filter">Path <input aria-label="Filter path" placeholder="src/components/" value={path} onChange={event => setPath(event.target.value)} /></label>
        </div>
      </details>
      {filtering && <button className="text-button" onClick={() => { setText(''); setBranch(''); setSince(''); setUntil(''); setPath(''); }}>Clear filters</button>}
    </div>
  </div>;
  function paletteCommands(): PaletteCommand[] {
    if (!state) return workspaceCommands;
    const writeBlocked = mutationBusy || mutationBlocked;
    const { head, headRef } = state.session;
    const repo: PaletteCommand[] = [
      { id: 'fetch', group: 'Repository', label: 'Fetch', icon: <RefreshCw size={15} />, disabled: writeBlocked, run: () => void runMenuRemote({ kind: 'fetch' }) },
      { id: 'pull', group: 'Repository', label: 'Pull', icon: <Download size={15} />, disabled: writeBlocked || !headRef, run: () => void runMenuRemote({ kind: 'pull', pullMode: DEFAULT_PULL_MODE }) },
      { id: 'push', group: 'Repository', label: 'Push', icon: <Upload size={15} />, disabled: writeBlocked || !headRef, run: () => { if (headRef) void pushFromMenu(headRef); } },
      { id: 'new-branch', group: 'Repository', label: 'New branch…', icon: <GitBranchPlus size={15} />, disabled: writeBlocked, run: () => setActionContext({ oid: head ?? '', ref: headRef ?? undefined, initial: 'createBranch' }) },
      { id: 'switch-branch', group: 'Repository', label: 'Switch branch…', icon: <GitBranch size={15} />, disabled: writeBlocked, run: () => setActionContext({ oid: head ?? '', initial: 'switchBranch' }) },
      { id: 'stash', group: 'Repository', label: 'Stash…', icon: <Archive size={15} />, disabled: writeBlocked, run: () => setStashOpen(true) },
      { id: 'working', group: 'Repository', label: 'Show working changes', icon: <FileDiff size={15} />, disabled: !status?.entries.length, run: () => reveal(WORKING_ID) },
      { id: 'search', group: 'Repository', label: 'Search history', hint: '/', icon: <Search size={15} />, run: () => requestAnimationFrame(() => search.current?.focus()) },
      { id: 'refresh', group: 'Repository', label: 'Refresh', icon: <RefreshCw size={15} />, disabled: busy, run: () => void refresh() },
      ...(head ? [{ id: 'copy-head', group: 'Repository', label: 'Copy HEAD commit SHA', hint: head.slice(0, 7), icon: <Copy size={15} />, run: () => void copyMenuValue(head, 'Commit SHA') }] : []),
    ];
    const branches = state.refs.filter(ref => ref.kind === 'local' && ref.fullName !== headRef).map(ref => ({ id: `switch:${ref.fullName}`, group: 'Switch to branch', label: `Switch to ${ref.name}`, icon: <Laptop size={15} />, disabled: writeBlocked, run: () => void switchBranch(ref.fullName) }));
    const goTo = state.refs.filter(ref => ref.kind !== 'local').map(ref => ({ id: `goto:${ref.fullName}`, group: 'Go to', label: `Go to ${ref.name}`, hint: ref.kind === 'tag' ? 'tag' : 'remote', icon: ref.kind === 'tag' ? <Tag size={15} /> : <Globe2 size={15} />, run: () => reveal(ref.commitId) }));
    return [...repo, ...branches, ...goTo, ...workspaceCommands];
  }
  return <>
    {active && paletteOpen && <CommandPalette commands={paletteCommands()} onClose={onClosePalette} />}
    {state && <RepositoryToolbar handle={state.session.handle} active={active} revision={revision} busy={mutationBusy || mutationBlocked} pickCount={pickOrder.length} pickMode={pickMode}
      onCreateBranch={() => setActionContext({ oid: state.session.head ?? '', ref: state.session.headRef ?? undefined, initial: 'createBranch' })}
      onSwitchBranch={() => setActionContext({ oid: state.session.head ?? '', initial: 'switchBranch' })}
      onCherryPick={() => setActionContext({ oid: pickOrder[0], commits: pickOrder, initial: 'cherryPick' })}
      onClearPick={() => { setPickMode(false); setPickOrder([]); }}
      onStartPickMode={() => setPickMode(true)}
      onOpenStash={() => setStashOpen(true)}
      onRefresh={() => void refresh()}
      onWrite={remoteWrite}
      fetchStatus={fetchStatus}
      notify={setNotice} />}
    {active && <>
      {actionError && <Toast tone="error" onDismiss={() => setActionError('')}>{actionError}</Toast>}
      {error && <Toast tone="error" action={<button className="secondary-button" disabled={busy} onClick={() => state ? void refresh() : void open()}>Retry</button>}>{error}</Toast>}
      {busy && !state && <Toast tone="progress">Opening {locationLabel(location)}…{location.kind === 'wsl' && ' A stopped WSL distribution can take a few seconds to start.'}</Toast>}
      {notice && <Toast onDismiss={() => setNotice('')}>{notice}</Toast>}
      {state && selected && selected !== WORKING_ID && !commits.some(commit => commit.id === selected) && <Toast action={cursor && <button className="secondary-button" disabled={busy} onClick={() => reveal(selected)}>Reveal</button>}>Selected commit {selected.slice(0, 12)} is {cursor ? 'outside the loaded history' : 'no longer reachable from the current references'}. Its inspector remains open by object ID.</Toast>}
    </>}
    {mutationBlocked && <div className="operation-banner" role="alert">Refresh failed after a write. Further writes are blocked until a successful refresh.<button className="secondary-button compact" onClick={() => void refresh()}>Refresh now</button></div>}
    {state && operation && (operation.kind !== 'none' || !!operation.conflicts.length) && <div className="operation-banner" role="status"><strong>{operation.label || operation.kind}</strong><span>{operation.current} {operation.incoming && `← ${operation.incoming}`}{operation.step !== null && ` · Step ${operation.step}${operation.total !== null ? ` / ${operation.total}` : ''}`}</span>{(['continue', 'skip', 'abort'] as const).map(kind => <button key={kind} className="secondary-button compact" disabled={mutationBusy || mutationBlocked || operation.kind === 'unsupported' || (kind === 'continue' && !operation.canContinue) || (kind === 'skip' && !operation.canSkip)} onClick={() => setActionContext({ oid: state.session.head ?? '', initial: kind })}>{kind === 'continue' ? 'Continue' : kind === 'skip' ? 'Skip' : 'Abort'}</button>)}{operation.conflicts.map(path => <button key={path} className="secondary-button compact" onClick={() => setConflictPath(path)}>Resolve {path}</button>)}</div>}
    {!state ? <main className="repo-skeleton" aria-busy={!error}>
      <div className="skeleton-sidebar" aria-hidden="true">{[70, 45, 90, 60, 80, 50].map((w, i) => <span key={i} className="skeleton" style={{ width: `${w}%` }} />)}</div>
      <div className="skeleton-history">
        <p role="status"><strong>{locationLabel(location)}</strong>{error ? 'This repository could not be opened. Use Retry once the problem is resolved.' : 'Reading repository state…'}</p>
        {!error && Array.from({ length: 12 }, (_, i) => <div key={i} className="skeleton-row" aria-hidden="true" style={{ animationDelay: `${i * 60}ms` }}><span className="skeleton-node" style={{ marginLeft: `${[0, 18, 0, 36, 18, 0][i % 6]}px` }} /><span className="skeleton" style={{ width: `${40 + ((i * 37) % 45)}%` }} /><span className="skeleton" style={{ width: 70 }} /></div>)}
      </div>
    </main> : <main className="workspace">
       {sidebarOpen && <><NativeSidebar state={state} commits={commits} filters={filters} busy={busy} reveal={reveal} switchBranch={ref => void switchBranch(ref)} openMenu={openMenu} onAction={setActionContext} /><PaneResizer label="Resize repository sidebar" width={sidebarWidth} onChange={setSidebarWidth} min={210} max={340} direction={1} /></>}
      <div className="workspace-main">
        {!sidebarOpen && filters}
        <div className="history-workspace">
          {activeDiff ? (
            <section className="diff-view-pane" aria-label={`Diff for ${activeDiff.path}`}>
              <div className="diff-view-header">
                <div className="diff-view-file">
                  <FileCode2 size={16} />
                  <span className="diff-view-filepath">{activeDiff.path}</span>
                  {activeDiff.group && <span className="badge" data-tone={GROUP_TONE[activeDiff.group]}>{activeDiff.group}</span>}
                </div>
                <div className="diff-view-actions">
                  {activeDiff.onToggleStage && (
                    <button className={`secondary-button diff-stage-btn ${activeDiff.isStaged ? 'unstage' : 'stage'}`} disabled={mutationBusy || mutationBlocked} onClick={activeDiff.onToggleStage}>
                      {activeDiff.isStaged ? 'Unstage File' : 'Stage File'}
                    </button>
                  )}
                  <Segmented label="Diff layout" value={split ? 'split' : 'unified'} options={[['unified', 'Unified'], ['split', 'Split']]} onChange={value => setSplit(value === 'split')} />
                  <button className="icon-button" aria-label="Close diff and show tree" title="Close diff" onClick={() => setActiveDiff(null)}>
                    <X size={17} />
                  </button>
                </div>
              </div>
              <div className="diff-view-body">
                {activeDiff.loading && <p className="diff-placeholder" role="status">Loading diff…</p>}
                {activeDiff.error && <p className="workflow-alert error" role="alert">{activeDiff.error}</p>}
                {!activeDiff.loading && activeDiff.diff && (
                  <DiffPreview
                    diff={activeDiff.diff}
                    split={split}
                    hunkAction={activeDiff.hunkAction}
                    busy={mutationBusy || mutationBlocked || activeDiff.busy}
                    onHunk={activeDiff.onHunk}
                  />
                )}
              </div>
            </section>
          ) : (
            <section className="history-pane" aria-label="Repository history">
              {filtering && <div className="native-search-results"><p role="status">{searchBusy ? 'Searching full history…' : `${result?.commits.length ?? 0} matches${result?.truncated ? ' · Results truncated; narrow the query' : ''}`} · Ancestry preserved</p>{searchError && <p role="alert">{searchError} <button onClick={() => setSearchRetry(value => value + 1)}>Retry search</button></p>}<div>{result?.commits.map(commit => <button key={commit.id} disabled={busy} onClick={() => reveal(commit.id)}>{commit.id.slice(0, 7)} {commit.subject}</button>)}</div></div>}
              {!graphCommits.length && <div className="empty-state"><GitCommitHorizontal size={28} /><h2>No commits yet</h2><p>This repository has no commits or working changes. Add files, stage them, and make your first commit.</p></div>}
               <HistoryGraph ref={graph} commits={graphCommits} layout={layout} refs={state.refs} selectedId={selected} head={state.session.head ?? ''} headRef={state.session.headRef} onActions={context => setActionContext(context)} onContextActions={openMenu} onSwitchBranch={ref => void switchBranch(ref)} pickOrder={pickOrder} onTogglePick={pickMode ? id => setPickOrder(order => toggleCommit(order, id)) : undefined} loaded={graphCommits.length} matches={matches} onSelect={id => reveal(id)} onLoadMore={() => void load()} onOpenDetails={() => setInspectorOpen(true)} theme={theme} hasMore={!!cursor} paging={busy} shallow={state.session.shallow} />
            </section>
          )}
          {inspectorOpen && <>
            <PaneResizer label="Resize inspector" width={inspectorWidth} onChange={setInspectorWidth} min={300} max={640} />
            {selected === WORKING_ID || (!selected && (status?.entries.length ?? 0) > 0) ? (
              <aside className="working-inspector-sidebar">
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
                notify={setNotice}
              />
            )}
          </>}
        </div>
      </div>
    </main>}
    <footer className="statusbar"><span><span className="live-dot" />{mutationBusy ? 'Updating repository…' : isDemoHandle(state?.session.handle) ? 'Demo workspace · changes are simulated in memory' : 'Local workspace · automatic refresh'}</span><span className="status-keys"><span className="scale-control"><button className="icon-button sm" aria-label="Zoom out" disabled={scale === SCALES[0]} onClick={() => stepScale(-1)}><ZoomOut size={13} /></button><select className="scale-value" aria-label="Interface zoom" value={scale} onChange={event => changeScale(Number(event.target.value))}>{SCALES.map(s => <option key={s} value={s}>{s}%</option>)}</select><button className="icon-button sm" aria-label="Zoom in" disabled={scale === SCALES[SCALES.length - 1]} onClick={() => stepScale(1)}><ZoomIn size={13} /></button></span><kbd>/</kbd> search <kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd> commands</span></footer>
    {state && menuTarget && <GraphContextMenu target={menuTarget} state={state} busy={mutationBusy || mutationBlocked} onClose={() => setMenuTarget(null)} onOperation={context => { setMenuTarget(null); setActionContext(context); }} onSwitchBranch={ref => { setMenuTarget(null); void switchBranch(ref); }} onShowDetails={oid => { reveal(oid); setInspectorOpen(true); setMenuTarget(null); }} onSetBase={oid => setComparison(oid, 'base')} onSetTarget={oid => setComparison(oid, 'target')} onCompare={compareWithCurrent} onPullRequest={ref => { setMenuTarget(null); setPrSource(ref); }} onRemoteAction={action => void runMenuRemote(action)} onPush={() => void pushFromMenu(menuTarget.context.ref!)} onCopy={(value, label) => void copyMenuValue(value, label)} />}
    {state && publishInfo && <PublishDialog remotes={publishInfo.remotes} branch={publishInfo.branch ?? ''} onPublish={async (remote, branch) => { const action: RemoteActionRequest = { kind: 'push', remote, branch, setUpstream: true }; const output = await remoteWrite('repository_remote_action', { action }); setNotice(output || 'Publish complete.'); }} onClose={() => setPublishInfo(null)} />}
    {state && actionContext && <OperationDialog key={state.session.handle} state={state} operation={operation} context={actionContext} commits={commits} busy={mutationBusy || mutationBlocked} onWrite={operationWrite} onClose={() => setActionContext(null)} onCompare={compareWithCurrent} onPullRequest={source => { setPrSource(source); setActionContext(null); }} />}
    {state && blockedSwitch && <SwitchBlockedDialog branch={blockedSwitch.branch} reason={blockedSwitch.reason} hasChanges={!!status?.entries.length} onReview={() => { setSelected(WORKING_ID); setInspectorOpen(true); setBlockedSwitch(null); }} onOperations={() => { setActionContext({ oid: blockedSwitch.oid, ref: blockedSwitch.ref, initial: 'switchBranch' }); setBlockedSwitch(null); }} onClose={() => setBlockedSwitch(null)} />}
    {state && conflictPath && <ConflictEditor key={`${state.session.handle}:${conflictPath}`} handle={state.session.handle} path={conflictPath} revision={revision} busy={mutationBusy || mutationBlocked} onWrite={operationWrite} onClose={() => setConflictPath(null)} />}
    {state && prSource && <PullRequestDialog key={state.session.handle} handle={state.session.handle} source={prSource} onClose={() => setPrSource(null)} />}
    {state && stashOpen && <RemoteStashDialog key={`${state.session.handle}:stash`} handle={state.session.handle} onWrite={remoteWrite} onClose={() => setStashOpen(false)} notify={setNotice} />}
  </>;
}
