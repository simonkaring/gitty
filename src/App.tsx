import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, CircleHelp, Command, Download, FolderGit2, GitBranch, GitCommitHorizontal, Github, LocateFixed, PanelLeft, PanelRight, Search, Upload, X } from 'lucide-react';
import { createDemoHistory } from './model/demo';
import { layoutHistory } from './graph/layout';
import { HistoryGraph, type GraphHandle } from './components/HistoryGraph';
import { Inspector } from './components/Inspector';
import { repositories, Sidebar } from './components/Sidebar';
import { isTauri } from '@tauri-apps/api/core';
import { NativeWorkspace } from './components/NativeWorkspace';
import { Brand, PaneResizer, ViewNavigation, usePaneWidth } from './components/WorkspaceControls';
import { WorkingChanges } from './components/WorkingChanges';
import { RepositoryTabs } from './components/RepositoryTabs';
import { demoCommittedFiles, demoFileDiff, demoStatus, demoWorkingFiles } from './model/demoWorkflow';
import type { DiffSpec, RepositoryMutation, RepositorySession } from './model/repository';
import type { MutationOutcome } from './model/workflow';
import { useSettings, type ThemeDefinition } from './model/settings';
import { SettingsButton } from './components/Settings';

export default function App() {
  const [demo, setDemo] = useState(() => !isTauri());
  return demo ? <><DemoApp />{isTauri() && <button className="native-switch" onClick={() => setDemo(false)}>Open real repository</button>}</> : <NativeWorkspace onDemo={() => setDemo(true)} />;
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
      <div className="titlebar-center"><FolderGit2 size={14} /><button onClick={() => setModal('repositories')}>{repository}<ChevronDown size={12} /></button><span className="titlebar-slash">/</span><span>Workspace</span></div>
      <div className="titlebar-actions"><button className="icon-button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setModal('help')}><CircleHelp size={17} /></button><SettingsButton /><span className="toolbar-divider" /><button className={`icon-button ${sidebarOpen ? 'toggled' : ''}`} aria-label="Toggle repositories sidebar" aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}><PanelLeft size={17} /></button><button className={`icon-button ${inspectorOpen ? 'toggled' : ''}`} aria-label="Toggle commit inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(value => !value)}><PanelRight size={17} /></button></div>
    </header>
    {/* Visual parity with the desktop tab strip: the demo only ever holds one
        repository open (switching replaces it, it does not add a tab), so
        this single tab is not closable and "+" reuses the existing
        repository picker below rather than pretending to open a second,
        simultaneous demo session. `branch`/`dirty` reflect real demo state,
        not placeholders. */}
    <RepositoryTabs tabs={[{ id: repository, title: repository, busy: false, branch: 'main', dirty }]} activeId={repository} onSelect={() => {}} onClose={() => notify('Closing tabs requires a desktop repository.')} onNew={() => setModal('repositories')} />
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

function Workspace({ repository, theme, sidebarOpen, inspectorOpen, inspectorWidth, setInspectorWidth, onRepository, setInspectorOpen, setModal, notify, onDirty }: WorkspaceProps) {
  const [snapshot, setSnapshot] = useState(() => createDemoHistory(repository === 'gitty' ? 1 : repository === 'orbit-design' ? 7 : 13));
  const [view, setView] = useState<'history' | 'working'>('history');
  const [sidebarWidth, setSidebarWidth] = usePaneWidth('sidebar', 240, 210, 340);
  const [workingFiles, setWorkingFiles] = useState(demoWorkingFiles);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const mutationLock = useRef(false);
  const workingStatus = useMemo(() => demoStatus(workingFiles, snapshot.head), [workingFiles, snapshot.head]);
  useEffect(() => { onDirty(workingStatus.entries.length > 0); }, [workingStatus.entries.length, onDirty]);
  const demoSession: RepositorySession = { handle: `demo:${repository}`, name: repository, root: `demo://${repository}`, gitDir: '', commonDir: '', location: { kind: 'native', path: `demo://${repository}` }, head: snapshot.head, headRef: 'refs/heads/main', linkedWorktree: false, shallow: false, bare: false };
  const loadDemoDiff = useCallback(async (_handle: string, spec: DiffSpec, path: string) => demoFileDiff(workingFiles, spec, path), [workingFiles]);
  async function mutate(mutation: RepositoryMutation): Promise<MutationOutcome> {
    if (mutation.kind === 'stage_hunk' || mutation.kind === 'unstage_hunk') return { error: 'Hunk staging is unavailable in the demo. Open a desktop repository to stage individual hunks.' };
    if (mutation.kind === 'amend') return { error: 'Amending history is unavailable in the demo. Open a desktop repository to rewrite the last commit.' };
    if (mutationLock.current) return { error: 'A demo operation is already running.' };
    mutationLock.current = true; setMutationBusy(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (mutation.kind === 'commit') {
        const files = demoCommittedFiles(workingFiles);
        if (!files.length) return { error: 'Stage changes before committing.' };
        const oid = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0');
        const [subject, ...body] = mutation.message.split('\n');
        setSnapshot(value => ({ ...value, head: oid, refs: value.refs.map(ref => ref.name === 'main' ? { ...ref, commitId: oid } : ref), commits: [{ id: oid, parents: [value.head], subject, body: body.join('\n').trim(), author: 'You', email: 'you@example.test', timestamp: Date.now(), branch: 'main', files }, ...value.commits] }));
        setWorkingFiles(value => value.map(file => ({ ...file, head: file.index })));
        setSelectedId(oid); setRevision(value => value + 1);
        return { oid };
      }
      setWorkingFiles(value => value.map(file => mutation.paths.includes(file.path) ? { ...file, index: mutation.kind === 'stage' ? file.working : file.head } : file));
      setRevision(value => value + 1);
      return {};
    } finally { mutationLock.current = false; setMutationBusy(false); }
  }
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
    setView('history');
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
    {sidebarOpen && <><Sidebar repository={repository} refs={snapshot.refs} onRepository={onRepository} onJump={jump} onAdd={() => setModal('repositories')} activeRef={activeRef} view={view} workingCount={workingStatus.entries.length} onView={setView} /><PaneResizer label="Resize repository sidebar" width={sidebarWidth} onChange={setSidebarWidth} min={210} max={340} direction={1} /></>}
    <div className="workspace-main"><div className="compact-view-nav"><ViewNavigation view={view} count={workingStatus.entries.length} onChange={setView} /></div><div className="history-workspace" hidden={view !== 'history'}>
    <section className="history-pane" aria-label="Repository history">
      <div className="repository-heading"><div className="repository-heading-main"><div className="repo-title-icon"><FolderGit2 size={23} strokeWidth={1.6} /></div><div><div className="repo-title-line"><h1>{repository}</h1><span className="local-badge">DEMO</span></div><p>{repositories.find(repo => repo.id === repository)?.path}</p></div></div><span className="branch-heading"><GitBranch size={14} /> main <span className="live-dot" /></span></div>
      <div className="history-title"><span><GitCommitHorizontal size={18} /><h2>History</h2><span className="count">{snapshot.commits.length.toLocaleString()}</span></span><span className="history-subtitle">The full picture of your work.</span></div>
      <div className="history-toolbar"><div className="ref-menu-wrapper" ref={refMenuRef}><button className={`branch-filter ${refMenu ? 'active' : ''}`} onClick={() => setRefMenu(value => !value)} aria-expanded={refMenu} aria-controls="branch-jump-menu"><GitBranch size={14} /><span>All branches</span><ChevronDown size={12} /></button>
        {refMenu && <div className="ref-menu" id="branch-jump-menu"><span className="menu-label">JUMP TO A REFERENCE</span>{snapshot.refs.map(ref => <button key={ref.name} onClick={() => jump(ref.commitId, ref.name)}><GitBranch size={13} /><span>{ref.name}</span></button>)}<p>All branches stay visible to preserve the graph.</p></div>}
      </div><div className="search-field"><Search size={14} /><input ref={searchRef} aria-label="Search commits, authors, branches, or SHA" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search commits…" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); nextResult(event.shiftKey ? -1 : 1); } }} />{query ? <button className="icon-button" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={13} /></button> : <kbd>/</kbd>}</div><button className="head-button" title="Jump to HEAD (H)" onClick={() => { setQuery(''); jump(snapshot.head, 'main'); graphRef.current?.focus(); }}><LocateFixed size={15} /><span>HEAD</span></button></div>
      {normalized && <div className="search-results" role="status"><span>{results.length ? `${matchIndex >= 0 ? `${matchIndex + 1} of ` : ''}${results.length} matches` : `No commits match “${query}”`}<span className="search-preserve"> · Full graph preserved</span></span><span><button className="icon-button" disabled={!results.length} aria-label="Previous search result" onClick={() => nextResult(-1)}><ArrowUp size={14} /></button><button className="icon-button" disabled={!results.length} aria-label="Next search result" onClick={() => nextResult(1)}><ArrowDown size={14} /></button></span></div>}
      <HistoryGraph ref={graphRef} commits={snapshot.commits} layout={layout} refs={snapshot.refs} selectedId={selectedId} head={snapshot.head} loaded={loaded} matches={matches} onSelect={id => { setSelectedId(id); setActiveRef(null); }} onLoadMore={() => setLoaded(value => Math.min(value + 240, snapshot.commits.length))} onOpenDetails={() => setInspectorOpen(true)} onActions={() => notify('Branch, merge, cherry-pick, tag and pull request actions require a desktop repository.')} theme={theme} />
    </section>
    {inspectorOpen && <><PaneResizer label="Resize commit inspector" width={inspectorWidth} onChange={setInspectorWidth} max={520} />
      <Inspector commit={selected} head={snapshot.head} onJump={jump} onClose={() => setInspectorOpen(false)} notify={notify} />
    </>}
    </div><div className="working-workspace-host" hidden={view !== 'working'}><WorkingChanges session={demoSession} status={workingStatus} revision={revision} busy={mutationBusy} onMutation={mutate} onRefresh={async () => { setRevision(value => value + 1); }} loadDiff={loadDemoDiff} demo /></div></div>
  </main>;
}
