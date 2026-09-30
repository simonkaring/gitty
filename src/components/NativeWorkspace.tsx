import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { Command, FolderOpen, Palette, PanelLeft, PanelRight, Search, Settings as SettingsIcon, Sparkles } from 'lucide-react';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import { useSettings } from '../model/settings';
import type { RepositoryLocation } from '../model/repository';
import { RepositoryPicker } from './RepositoryPicker';
import { Welcome } from './Welcome';
import { Brand, usePaneWidth } from './WorkspaceControls';
import { SettingsButton } from './Settings';
import { RepositoryPane } from './RepositoryPane';
import { RepositoryTabs, type RepositoryTabSummary } from './RepositoryTabs';
import { loadPersistedTabs, locationLabel, savePersistedTabs, tabsReducer, type TabsState } from '../model/tabs';
import { errorMessage, handleWindowDrag, native } from '../model/native';
import { cloneReducer, type CloneProgress, type CloneRequest } from '../model/clone';

function initialTabsState(): TabsState {
  const persisted = loadPersistedTabs(window.localStorage);
  return {
    tabs: persisted.tabs.map(tab => ({ id: tab.id, location: tab.location, title: locationLabel(tab.location), key: null, busy: false, branch: null, dirty: false })),
    activeId: persisted.activeId,
    notice: null,
  };
}

export function NativeWorkspace({ onDemo }: { onDemo: () => void }) {
  // `tabsReducer` is a pure function: opening, deduping, closing, and
  // meta/busy updates never call `notify`/`setActiveId` as a side effect of
  // computing the next state. Under React StrictMode a `setTabs(current =>
  // ...)` updater that also called `setActiveId` inside it could be invoked
  // twice per dispatch, committing a *different* freshly-generated tab id
  // than the one in the committed tabs array — the newly opened tab then
  // never matched `activeId` and stayed permanently hidden. Routing every
  // transition through one reducer call removes that whole class of bug.
  const [{ tabs, activeId, notice: pendingNotice }, dispatch] = useReducer(tabsReducer, undefined, initialTabsState);
  const [picker, setPicker] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 1000);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 900);
  const [inspectorWidth, setInspectorWidth] = usePaneWidth('inspector', 400, 300, 640);
  const [sidebarWidth, setSidebarWidth] = usePaneWidth('sidebar', 240, 210, 340);
  const [notice, setNotice] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { themes, theme, updateSettings, openSettings } = useSettings();
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k' || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, []);
  const [clone, dispatchClone] = useReducer(cloneReducer, { status: 'idle' });
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4500);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
  useEffect(() => { savePersistedTabs(window.localStorage, { tabs: tabs.map(tab => ({ id: tab.id, location: tab.location })), activeId }); }, [tabs, activeId]);
  // The only place a tab-strip notice is ever shown: the reducer just records
  // the message in state, and this effect (not the reducer, not an updater
  // callback) is what actually calls `notify`.
  useEffect(() => { if (pendingNotice) { notify(pendingNotice); dispatch({ type: 'noticeShown' }); } }, [pendingNotice, notify]);

  const openLocation = useCallback((location: RepositoryLocation) => { dispatch({ type: 'open', location }); setPicker(false); }, []);
  const startClone = useCallback((request: CloneRequest) => {
    if (clone.status === 'running' || clone.status === 'cancelling') return;
    const operationId = crypto.randomUUID();
    const onProgress = new Channel<CloneProgress>();
    onProgress.onmessage = progress => dispatchClone({ type: 'progress', operationId, progress });
    dispatchClone({ type: 'start', operationId, request });
    setPicker(false);
    void native<RepositoryLocation>('repository_clone', { operationId, request, onProgress }).then(location => {
      dispatchClone({ type: 'finish', operationId });
      dispatch({ type: 'open', location });
      notify(`Cloned ${request.directoryName}.`);
    }).catch(error => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'cancelled') {
        dispatchClone({ type: 'finish', operationId });
        notify(`Cancelled clone of ${request.directoryName}.`);
      } else dispatchClone({ type: 'fail', operationId, message: errorMessage(error) });
    });
  }, [clone.status, notify]);
  const cancelClone = useCallback(() => {
    if (clone.status !== 'running') return;
    const operationId = clone.operationId;
    dispatchClone({ type: 'cancel', operationId });
    void native('repository_cancel_clone', { operationId }).catch(error => {
      dispatchClone({ type: 'cancelRejected', operationId });
      notify(`Could not request clone cancellation: ${errorMessage(error)}`);
    });
  }, [clone, notify]);
  const handleIdentity = useCallback((tabId: string, key: string | null, title: string | null) => dispatch({ type: 'identity', tabId, key, title }), []);
  const handleBusyChange = useCallback((tabId: string, busy: boolean) => dispatch({ type: 'busy', tabId, busy }), []);
  const handleMeta = useCallback((tabId: string, branch: string | null, dirty: boolean) => dispatch({ type: 'meta', tabId, branch, dirty }), []);
  const selectTab = useCallback((tabId: string) => dispatch({ type: 'select', tabId }), []);
  const closeTab = useCallback((tabId: string) => dispatch({ type: 'close', tabId }), []);

  const cloneBusy = clone.status === 'running' || clone.status === 'cancelling';
  const anyBusy = tabs.some(tab => tab.busy) || cloneBusy;
  function requestDemo() {
    // The demo workspace fully unmounts this component (and every tab pane
    // in it, closing their sessions) — never do that while a write is
    // in-flight in any tab, even one that isn't currently active.
    if (anyBusy) { notify('Cannot switch to the demo workspace while an operation is running in a tab. Wait for it to finish, or switch to that tab.'); return; }
    onDemo();
  }

  const workspaceCommands: PaletteCommand[] = [
    { id: 'open', group: 'Workspace', label: 'Open repository…', icon: <FolderOpen size={15} />, run: () => setPicker(true) },
    { id: 'sidebar', group: 'Workspace', label: `${sidebarOpen ? 'Hide' : 'Show'} references sidebar`, icon: <PanelLeft size={15} />, run: () => setSidebarOpen(!sidebarOpen) },
    { id: 'inspector', group: 'Workspace', label: `${inspectorOpen ? 'Hide' : 'Show'} inspector`, icon: <PanelRight size={15} />, run: () => setInspectorOpen(!inspectorOpen) },
    { id: 'settings', group: 'Workspace', label: 'Open settings', icon: <SettingsIcon size={15} />, run: () => openSettings() },
    { id: 'demo', group: 'Workspace', label: 'Explore demo workspace', icon: <Sparkles size={15} />, disabled: anyBusy, run: requestDemo },
    ...themes.filter(t => t.id !== theme.id).map(t => ({ id: `theme:${t.id}`, group: 'Theme', label: `Theme: ${t.name}`, hint: t.mode, icon: <Palette size={15} />, run: () => updateSettings({ themeMode: 'fixed', themeId: t.id }) })),
  ];
  const isMac = document.documentElement.dataset.platform === 'macos' || /Mac/.test(navigator.platform);
  const tabSummaries: RepositoryTabSummary[] = tabs.map(tab => ({ id: tab.id, title: tab.title, busy: tab.busy, branch: tab.branch, dirty: tab.dirty }));
  return <div className="app-shell native-shell" style={{ '--inspector-width': `${inspectorWidth}px`, '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
    <header className="titlebar" data-tauri-drag-region onMouseDown={handleWindowDrag}>
      <Brand />
      <RepositoryTabs tabs={tabSummaries} activeId={activeId} onSelect={selectTab} onClose={closeTab} onNew={() => setPicker(true)} />
      <div className="native-actions">
        <button className="palette-trigger" aria-label="Search commands" aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'} onClick={() => setPaletteOpen(true)}><Search size={14} /><span>Search commands</span><kbd>{isMac ? <><Command size={11} />K</> : 'Ctrl K'}</kbd></button>
        <button className="secondary-button" onClick={() => setPicker(true)}>Open repository…</button>
        <button className="text-button" disabled={anyBusy} title={anyBusy ? 'Finish or switch to the tab with a running operation first.' : undefined} onClick={requestDemo}>Demo</button>
        <SettingsButton />
        <button className="icon-button" aria-label="Toggle references sidebar" aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><PanelLeft size={18} /></button>
        <button className="icon-button" aria-label="Toggle working changes and inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}><PanelRight size={18} /></button>
      </div>
    </header>
    <div className="toast-region">
    {notice && <div className="native-banner" role="status">{notice}</div>}
    {cloneBusy && <div className="clone-progress" role="status" aria-live="polite"><div><strong>{clone.status === 'cancelling' ? 'Cancelling clone…' : `Cloning ${clone.destinationName}`}</strong><span>{clone.progress?.message ?? 'Starting Git…'}</span>{clone.progress?.percent !== null && clone.progress?.percent !== undefined && <progress max="100" value={clone.progress.percent}>{clone.progress.percent}%</progress>}</div><button disabled={clone.status === 'cancelling'} onClick={cancelClone}>Cancel clone</button></div>}
    {clone.status === 'error' && <div className="native-banner" role="alert">Clone failed: {clone.message} <button onClick={() => dispatchClone({ type: 'dismiss' })}>Dismiss</button></div>}
    </div>
    {!tabs.length ? <Welcome showRecent={!picker} onOpenPicker={() => setPicker(true)} onOpen={openLocation} onDemo={onDemo} />
      : tabs.map(tab => <div key={tab.id} id={`tabpanel-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} hidden={tab.id !== activeId} className="tab-pane-host">
        <RepositoryPane tabId={tab.id} location={tab.location} active={tab.id === activeId}
          sidebarOpen={sidebarOpen} inspectorOpen={inspectorOpen} inspectorWidth={inspectorWidth} sidebarWidth={sidebarWidth}
          setInspectorWidth={setInspectorWidth} setSidebarWidth={setSidebarWidth} setInspectorOpen={setInspectorOpen}
          onIdentity={handleIdentity} onBusyChange={handleBusyChange} onMeta={handleMeta}
          paletteOpen={paletteOpen} onClosePalette={() => setPaletteOpen(false)} workspaceCommands={workspaceCommands} />
      </div>)}
    {!tabs.length && paletteOpen && <CommandPalette commands={workspaceCommands} onClose={() => setPaletteOpen(false)} />}
    {picker && <RepositoryPicker onOpen={openLocation} onClone={startClone} cloneBusy={cloneBusy} onClose={() => setPicker(false)} />}
  </div>;
}
