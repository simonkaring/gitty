import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, CircleHelp, Command, Download, FileCode2, FolderGit2, GitBranch, Github, PanelLeft, PanelRight, Upload, X } from 'lucide-react';
import { createDemoHistory } from './model/demo';
import { layoutHistory } from './graph/layout';
import { HistoryGraph, type GraphHandle } from './components/HistoryGraph';
import { Inspector } from './components/Inspector';
import { repositories, Sidebar } from './components/Sidebar';
import { isTauri } from '@tauri-apps/api/core';
import { NativeWorkspace } from './components/NativeWorkspace';
import { Brand, PaneResizer, usePaneWidth } from './components/WorkspaceControls';
import { DiffPreview, type ActiveDiffState } from './components/WorkingChanges';
import { RepositoryTabs } from './components/RepositoryTabs';
import { useSettings, type ThemeDefinition } from './model/settings';
import { SettingsButton } from './components/Settings';

import { AskPassDialog } from './components/AskPassDialog';

export default function App() {
  const [demo, setDemo] = useState(() => !isTauri());
  return (
    <>
      {demo ? <><DemoApp />{isTauri() && <button className="native-switch" onClick={() => setDemo(false)}>Open real repository</button>}</> : <NativeWorkspace onDemo={() => setDemo(true)} />}
      {isTauri() && <AskPassDialog />}
    </>
  );
}

function DemoApp() {
  const [repository, setRepository] = useState('gitty');
  const { theme } = useSettings();
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 1000);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 760);
  const [inspectorWidth, setInspectorWidth] = usePaneWidth('inspector', 400, 300, 520);
  const [modal, setModal] = useState<'help' | 'repositories' | null>(null);
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalRef = useRef<HTMLDialogElement>(null);
  const notify = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 3500);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
  useEffect(() => { if (modal) modalRef.current?.showModal(); else modalRef.current?.close(); }, [modal]);

  return <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-hidden'} ${inspectorOpen ? '' : 'inspector-hidden'}`} style={{ '--inspector-width': `${inspectorWidth}px` } as CSSProperties}>
    <header className="titlebar">
      <Brand demo />
      <RepositoryTabs tabs={[{ id: repository, title: repository, busy: false, branch: 'main', dirty }]} activeId={repository} onSelect={() => {}} onClose={() => notify('Closing tabs requires a desktop repository.')} onNew={() => setModal('repositories')} />
      <div className="titlebar-actions"><button className="icon-button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setModal('help')}><CircleHelp size={17} /></button><SettingsButton /><span className="toolbar-divider" /><button className={`icon-button ${sidebarOpen ? 'toggled' : ''}`} aria-label="Toggle references sidebar" aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}><PanelLeft size={17} /></button><button className={`icon-button ${inspectorOpen ? 'toggled' : ''}`} aria-label="Toggle working changes and inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(value => !value)}><PanelRight size={17} /></button></div>
    </header>
    <div className="repository-toolbar" aria-label="Repository actions (desktop only)">
      <div className="repository-toolbar-group"><button disabled title="Requires a desktop repository"><Download size={15} />Pull</button><button disabled title="Requires a desktop repository"><Upload size={15} />Push</button><button disabled title="Requires a desktop repository"><GitBranch size={15} />Branch</button><button disabled title="Requires a desktop repository">Stash…</button></div>
      <span className="repository-sync-badge">Sync and stash actions require a desktop repository</span>
    </div>
    <Workspace key={repository} repository={repository} theme={theme} sidebarOpen={sidebarOpen} inspectorOpen={inspectorOpen} inspectorWidth={inspectorWidth} setInspectorWidth={setInspectorWidth} onRepository={setRepository} setInspectorOpen={setInspectorOpen} setModal={setModal} notify={notify} onDirty={setDirty} />
    <footer className="statusbar"><span><span className="live-dot" /> Demo workspace <span className="status-separator">·</span> All changes are illustrative</span><span className="status-shortcuts"><kbd>↑</kbd><kbd>↓</kbd> navigate <span className="status-separator">·</span><kbd>/</kbd> search <span className="status-separator">·</span><kbd>?</kbd> shortcuts</span><span className="version"><GitBranch size={12} /> Gitty <span>0.1.0</span></span></footer>
    <div className={`toast ${notice ? 'visible' : ''}`} role="status" aria-live="polite">{notice && <><Check size={15} />{notice}</>}</div>
    <dialog ref={modalRef} className="dialog" aria-label={modal === 'help' ? 'Keyboard shortcuts' : 'Choose a demo repository'} onCancel={() => setModal(null)} onClick={event => { if (event.target === event.currentTarget) setModal(null); }}>
      <div className="dialog-heading"><span className="dialog-icon">{modal === 'help' ? <Command size={22} /> : <FolderGit2 size={22} />}</span><button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}><X size={18} /></button></div>
      {modal === 'help' ? <><h2>Keyboard shortcuts</h2><p>Move through history without leaving the keyboard.</p><div className="shortcut-list">{[['Search history', '⌘ / Ctrl K or /'], ['Move between commits', '↑ / ↓'], ['Move one page', 'Page Up / Down'], ['First / last loaded commit', 'Home / End'], ['Jump to HEAD', 'H'], ['Open commit inspector', 'Enter'], ['Clear search', 'Esc'], ['Show these shortcuts', '?']].map(([label, keys]) => <div key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}</div><p className="dialog-footnote">History navigation works while the commit list is focused.</p></> : <><h2>Choose a repository</h2><p>Explore a synthetic history and try staging changes.</p><div className="repo-picker">{repositories.map(repo => <button key={repo.id} onClick={() => { setRepository(repo.id); setModal(null); }}><span className={`repo-icon ${repo.color}`}><FolderGit2 size={20} /></span><span><strong>{repo.name}</strong><small>{repo.language} <span>·</span> Synthetic history</small></span>{repo.id === repository ? <Check size={17} /> : <ArrowUpRight size={17} />}</button>)}</div><div className="demo-explanation"><Github size={18} /><span>Demo changes are simulated in memory. Open the desktop app to work with your local repositories.</span></div></>}
    </dialog>
  </div>;
}

interface WorkspaceProps {
  repository: string; theme: ThemeDefinition; sidebarOpen: boolean; inspectorOpen: boolean; inspectorWidth: number;
  setInspectorWidth: (value: number) => void; onRepository: (id: string) => void; setInspectorOpen: (value: boolean) => void;
  setModal: (value: 'help' | 'repositories' | null) => void; notify: (message: string) => void; onDirty: (dirty: boolean) => void;
}

function Workspace({ repository, theme, sidebarOpen, inspectorOpen, inspectorWidth, setInspectorWidth, setInspectorOpen, setModal, notify, onDirty }: WorkspaceProps) {
  const [snapshot] = useState(() => createDemoHistory(repository === 'gitty' ? 1 : repository === 'orbit-design' ? 7 : 13));
  const [activeDiff, setActiveDiff] = useState<ActiveDiffState | null>(null);
  const { settings } = useSettings();
  const [split, setSplit] = useState(() => settings.diffView !== 'unified');
  useEffect(() => setSplit(settings.diffView !== 'unified'), [settings.diffView]);
  const [sidebarWidth, setSidebarWidth] = usePaneWidth('sidebar', 240, 210, 340);
  useEffect(() => { onDirty(false); }, [onDirty]);
  const layout = useMemo(() => layoutHistory(snapshot.commits), [snapshot]);
  const [selectedId, setSelectedId] = useState(snapshot.head);
  const [loaded, setLoaded] = useState(240);
  const [query, setQuery] = useState('');
  const [activeRef, setActiveRef] = useState<string | null>('main');
  const [refMenu, setRefMenu] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const graphRef = useRef<GraphHandle>(null);
  const refMenuRef = useRef<HTMLDivElement>(null);
  const [scrollRequest, setScrollRequest] = useState<{ row: number } | null>(null);
  const selected = snapshot.commits.find(commit => commit.id === selectedId)!;
  const normalized = query.trim().toLowerCase();
  const results = useMemo(() => normalized ? snapshot.commits.filter(commit => `${commit.subject} ${commit.author} ${commit.id} ${commit.branch} ${snapshot.refs.filter(ref => ref.commitId === commit.id).map(ref => ref.name).join(' ')}`.toLowerCase().includes(normalized)) : [], [normalized, snapshot]);
  const matches = useMemo(() => normalized ? new Set(results.map(commit => commit.id)) : null, [results, normalized]);
  const matchIndex = results.findIndex(commit => commit.id === selectedId);
  const jump = useCallback((id: string, refName?: string) => {
    setActiveDiff(null);
    const row = snapshot.commits.findIndex(commit => commit.id === id);
    if (row < 0) return;
    setSelectedId(id); setActiveRef(refName ?? null); setRefMenu(false);
    setLoaded(value => Math.max(value, Math.min(snapshot.commits.length, Math.ceil((row + 1) / 240) * 240)));
    setScrollRequest({ row });
  }, [snapshot]);
  useEffect(() => {
    if (scrollRequest) graphRef.current?.scrollTo(scrollRequest.row);
  }, [scrollRequest]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (document.querySelector('dialog[open]')) return;
      const editable = event.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); return; }
      if (event.key === 'Escape') { setQuery(''); setRefMenu(false); searchRef.current?.blur(); graphRef.current?.focus(); }
      if (editable || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '/') { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key.toLowerCase() === 'h') { event.preventDefault(); setQuery(''); jump(snapshot.head, 'main'); graphRef.current?.focus(); }
      if (event.key === '?') { event.preventDefault(); setModal('help'); }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [jump, snapshot.head, setModal]);
  useEffect(() => {
    if (!refMenu) return;
    function close(event: PointerEvent) { if (!refMenuRef.current?.contains(event.target as Node)) setRefMenu(false); }
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [refMenu]);
  function nextResult(direction: number) {
    if (!results.length) return;
    const index = matchIndex < 0 ? direction > 0 ? 0 : results.length - 1 : (matchIndex + direction + results.length) % results.length;
    jump(results[index].id);
  }
  return <main className="workspace" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
    {sidebarOpen && <><Sidebar
      repository={repository}
      refs={snapshot.refs}
      onJump={jump}
      onSwitchBranch={() => notify('Switching branches requires a desktop repository.')}
      activeRef={activeRef}
      commitCount={snapshot.commits.length}
      query={query}
      setQuery={setQuery}
      searchRef={searchRef}
      nextResult={nextResult}
      onHead={() => { setQuery(''); jump(snapshot.head, 'main'); graphRef.current?.focus(); }}
      refMenu={refMenu}
      setRefMenu={setRefMenu}
      refMenuRef={refMenuRef}
    /><PaneResizer label="Resize repository sidebar" width={sidebarWidth} onChange={setSidebarWidth} min={210} max={340} direction={1} /></>}
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
                  <button className={`secondary-button diff-stage-btn ${activeDiff.isStaged ? 'unstage' : 'stage'}`} disabled={activeDiff.busy} onClick={activeDiff.onToggleStage}>
                    {activeDiff.isStaged ? 'Unstage File' : 'Stage File'}
                  </button>
                )}
                <button className="secondary-button" aria-pressed={split} onClick={() => setSplit(!split)}>
                  {split ? 'Unified' : 'Side by side'}
                </button>
                <button className="icon-button" aria-label="Close diff and show graph" title="Close diff" onClick={() => setActiveDiff(null)}>
                  <X size={17} />
                </button>
              </div>
            </div>
            <div className="diff-view-body">
              {activeDiff.loading && <p className="diff-placeholder" role="status">Loading diff…</p>}
              {activeDiff.error && <p className="workflow-alert error" role="alert">{activeDiff.error}</p>}
              {activeDiff.diff && <DiffPreview diff={activeDiff.diff} split={split} hunkAction={activeDiff.hunkAction} busy={activeDiff.busy} unavailable="Hunk staging is unavailable in the demo." onHunk={activeDiff.onHunk} />}
            </div>
          </section>
        ) : (
          <section className="history-pane" aria-label="Repository history">
            {normalized && <div className="search-results" role="status"><span>{results.length ? `${matchIndex >= 0 ? `${matchIndex + 1} of ` : ''}${results.length} matches` : `No commits match “${query}”`}<span className="search-preserve"> · Full graph preserved</span></span><span><button className="icon-button" disabled={!results.length} aria-label="Previous search result" onClick={() => nextResult(-1)}><ArrowUp size={14} /></button><button className="icon-button" disabled={!results.length} aria-label="Next search result" onClick={() => nextResult(1)}><ArrowDown size={14} /></button></span></div>}
            <HistoryGraph ref={graphRef} commits={snapshot.commits} layout={layout} refs={snapshot.refs} selectedId={selectedId} head={snapshot.head} loaded={loaded} matches={matches} onSelect={id => { setActiveDiff(null); setSelectedId(id); setActiveRef(null); }} onLoadMore={() => setLoaded(value => Math.min(value + 240, snapshot.commits.length))} onOpenDetails={() => setInspectorOpen(true)} onActions={() => notify('Branch, merge, cherry-pick, tag and pull request actions require a desktop repository.')} onSwitchBranch={() => notify('Switching branches requires a desktop repository.')} theme={theme} />
          </section>
        )}
        {inspectorOpen && <><PaneResizer label="Resize commit inspector" width={inspectorWidth} onChange={setInspectorWidth} max={520} />
          <Inspector
            commit={selected}
            head={snapshot.head}
            onJump={jump}
            onClose={() => setInspectorOpen(false)}
            notify={notify}
            activePath={activeDiff?.path ?? null}
            onActiveDiffChange={setActiveDiff}
          />
        </>}
      </div>
    </div>
  </main>;
}
