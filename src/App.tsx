import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, CircleHelp, Command, FolderGit2, GitBranch, GitCommitHorizontal, Github, LocateFixed, Moon, PanelLeft, PanelRight, Search, Sun, X } from 'lucide-react';
import { createDemoHistory } from './model/demo';
import { layoutHistory } from './graph/layout';
import { HistoryGraph, type GraphHandle } from './components/HistoryGraph';
import { Inspector } from './components/Inspector';
import { repositories, Sidebar } from './components/Sidebar';
import { isTauri } from '@tauri-apps/api/core';
import { NativeWorkspace } from './components/NativeWorkspace';

function preference(key: string, fallback: string) {
  try { return localStorage.getItem(`gitty:${key}`) ?? fallback; } catch { return fallback; }
}
function savePreference(key: string, value: string) { try { localStorage.setItem(`gitty:${key}`, value); } catch { /* Storage may be disabled in a web preview. */ } }

export default function App() {
  const [demo, setDemo] = useState(() => !isTauri());
  return demo ? <><DemoApp />{isTauri() && <button className="native-switch" onClick={() => setDemo(false)}>Open real repository</button>}</> : <NativeWorkspace onDemo={() => setDemo(true)} />;
}

function DemoApp() {
  const [repository, setRepository] = useState('gitty');
  const [theme, setTheme] = useState(() => preference('theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 1000);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 760);
  const [inspectorWidth, setInspectorWidth] = useState(() => Math.max(300, Math.min(520, Number(preference('inspector-width', '360')) || 360)));
  const [modal, setModal] = useState<'help' | 'repositories' | null>(null);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalRef = useRef<HTMLDialogElement>(null);
  const notify = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 3500);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; savePreference('theme', theme); }, [theme]);
  useEffect(() => { savePreference('inspector-width', String(inspectorWidth)); }, [inspectorWidth]);
  useEffect(() => { if (modal) modalRef.current?.showModal(); else modalRef.current?.close(); }, [modal]);

  return <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-hidden'} ${inspectorOpen ? '' : 'inspector-hidden'}`} style={{ '--inspector-width': `${inspectorWidth}px` } as CSSProperties}>
    <header className="titlebar">
      <div className="brand"><span className="brand-icon"><GitBranch size={20} strokeWidth={2.1} /></span><span>gitty<span className="brand-period">.</span></span><span className="preview-label">PREVIEW</span></div>
      <div className="titlebar-center"><FolderGit2 size={14} /><button onClick={() => setModal('repositories')}>{repository}<ChevronDown size={12} /></button><span className="titlebar-slash">/</span><span>Workspace</span></div>
      <div className="titlebar-actions"><button className="icon-button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setModal('help')}><CircleHelp size={17} /></button><button className="icon-button" title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button><span className="toolbar-divider" /><button className={`icon-button ${sidebarOpen ? 'toggled' : ''}`} aria-label="Toggle repositories sidebar" aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}><PanelLeft size={17} /></button><button className={`icon-button ${inspectorOpen ? 'toggled' : ''}`} aria-label="Toggle commit inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(value => !value)}><PanelRight size={17} /></button></div>
    </header>
    <Workspace key={repository} repository={repository} theme={theme} sidebarOpen={sidebarOpen} inspectorOpen={inspectorOpen} inspectorWidth={inspectorWidth} setInspectorWidth={setInspectorWidth} onRepository={setRepository} setInspectorOpen={setInspectorOpen} setModal={setModal} notify={notify} />
    <footer className="statusbar"><span><span className="live-dot" /> Demo workspace <span className="status-separator">·</span> All changes are illustrative</span><span className="status-shortcuts"><kbd>↑</kbd><kbd>↓</kbd> navigate <span className="status-separator">·</span><kbd>/</kbd> search <span className="status-separator">·</span><kbd>?</kbd> shortcuts</span><span className="version"><GitBranch size={12} /> Gitty <span>0.1.0</span></span></footer>
    <div className={`toast ${notice ? 'visible' : ''}`} role="status" aria-live="polite">{notice && <><Check size={15} />{notice}</>}</div>
    <dialog ref={modalRef} className="dialog" aria-label={modal === 'help' ? 'Keyboard shortcuts' : 'Choose a demo repository'} onCancel={() => setModal(null)} onClick={event => { if (event.target === event.currentTarget) setModal(null); }}>
      <div className="dialog-heading"><span className="dialog-icon">{modal === 'help' ? <Command size={22} /> : <FolderGit2 size={22} />}</span><button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}><X size={18} /></button></div>
      {modal === 'help' ? <><h2>A few small shortcuts.</h2><p>Less reaching. More flow.</p><div className="shortcut-list">{[['Search history', '⌘ / Ctrl K or /'], ['Move between commits', '↑ / ↓'], ['Move one page', 'Page Up / Down'], ['First / last loaded commit', 'Home / End'], ['Jump to HEAD', 'H'], ['Open commit inspector', 'Enter'], ['Clear search', 'Esc'], ['Show these shortcuts', '?']].map(([label, keys]) => <div key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}</div><p className="dialog-footnote">History navigation works while the commit list is focused.</p></> : <><h2>Find your next little thing.</h2><p>Choose a demo repository to explore its history.</p><div className="repo-picker">{repositories.map(repo => <button key={repo.id} onClick={() => { setRepository(repo.id); setModal(null); }}><span className={`repo-icon ${repo.color}`}><FolderGit2 size={20} /></span><span><strong>{repo.name}</strong><small>{repo.language} <span>·</span> Synthetic history</small></span>{repo.id === repository ? <Check size={17} /> : <ArrowUpRight size={17} />}</button>)}</div><div className="demo-explanation"><Github size={18} /><span>Local repository access is coming in a future milestone. This preview uses deterministic demo data.</span></div></>}
    </dialog>
  </div>;
}

interface WorkspaceProps {
  repository: string; theme: string; sidebarOpen: boolean; inspectorOpen: boolean; inspectorWidth: number;
  setInspectorWidth: (value: number) => void; onRepository: (id: string) => void; setInspectorOpen: (value: boolean) => void;
  setModal: (value: 'help' | 'repositories' | null) => void; notify: (message: string) => void;
}

function Workspace({ repository, theme, sidebarOpen, inspectorOpen, inspectorWidth, setInspectorWidth, onRepository, setInspectorOpen, setModal, notify }: WorkspaceProps) {
  const snapshot = useMemo(() => createDemoHistory(repository === 'gitty' ? 1 : repository === 'orbit-design' ? 7 : 13), [repository]);
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
  return <main className="workspace">
    {sidebarOpen && <Sidebar repository={repository} refs={snapshot.refs} onRepository={onRepository} onJump={jump} onAdd={() => setModal('repositories')} activeRef={activeRef} />}
    <section className="history-pane" aria-label="Repository history">
      <div className="repository-heading"><div className="repository-heading-main"><div className="repo-title-icon"><FolderGit2 size={23} strokeWidth={1.6} /></div><div><div className="repo-title-line"><h1>{repository}</h1><span className="local-badge">DEMO</span></div><p>{repositories.find(repo => repo.id === repository)?.path}</p></div></div><span className="branch-heading"><GitBranch size={14} /> main <span className="live-dot" /></span></div>
      <div className="history-title"><span><GitCommitHorizontal size={18} /><h2>History</h2><span className="count">{snapshot.commits.length.toLocaleString()}</span></span><span className="history-subtitle">Every little step, connected.</span></div>
      <div className="history-toolbar"><div className="ref-menu-wrapper" ref={refMenuRef}><button className={`branch-filter ${refMenu ? 'active' : ''}`} onClick={() => setRefMenu(value => !value)} aria-expanded={refMenu} aria-controls="branch-jump-menu"><GitBranch size={14} /><span>All branches</span><ChevronDown size={12} /></button>
        {refMenu && <div className="ref-menu" id="branch-jump-menu"><span className="menu-label">JUMP TO A REFERENCE</span>{snapshot.refs.map(ref => <button key={ref.name} onClick={() => jump(ref.commitId, ref.name)}><GitBranch size={13} /><span>{ref.name}</span></button>)}<p>All branches stay visible to preserve the graph.</p></div>}
      </div><div className="search-field"><Search size={14} /><input ref={searchRef} aria-label="Search commits, authors, branches, or SHA" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search commits…" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); nextResult(event.shiftKey ? -1 : 1); } }} />{query ? <button className="icon-button" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={13} /></button> : <kbd>/</kbd>}</div><button className="head-button" title="Jump to HEAD (H)" onClick={() => { setQuery(''); jump(snapshot.head, 'main'); graphRef.current?.focus(); }}><LocateFixed size={15} /><span>HEAD</span></button></div>
      {normalized && <div className="search-results" role="status"><span>{results.length ? `${matchIndex >= 0 ? `${matchIndex + 1} of ` : ''}${results.length} matches` : `No commits match “${query}”`}<span className="search-preserve"> · Full graph preserved</span></span><span><button className="icon-button" disabled={!results.length} aria-label="Previous search result" onClick={() => nextResult(-1)}><ArrowUp size={14} /></button><button className="icon-button" disabled={!results.length} aria-label="Next search result" onClick={() => nextResult(1)}><ArrowDown size={14} /></button></span></div>}
      <HistoryGraph ref={graphRef} commits={snapshot.commits} layout={layout} refs={snapshot.refs} selectedId={selectedId} head={snapshot.head} loaded={loaded} matches={matches} onSelect={id => { setSelectedId(id); setActiveRef(null); }} onLoadMore={() => setLoaded(value => Math.min(value + 240, snapshot.commits.length))} onOpenDetails={() => setInspectorOpen(true)} theme={theme} />
    </section>
    {inspectorOpen && <><div className="pane-resizer" role="separator" aria-label="Resize commit inspector" aria-orientation="vertical" aria-valuenow={inspectorWidth} aria-valuemin={300} aria-valuemax={520} tabIndex={0}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setInspectorWidth(event.key === 'Home' ? 300 : event.key === 'End' ? 520 : Math.max(300, Math.min(520, inspectorWidth + (event.key === 'ArrowLeft' ? 20 : -20)))); } }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.dragging = 'true'; }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setInspectorWidth(Math.max(300, Math.min(520, window.innerWidth - event.clientX))); }}
      onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); delete event.currentTarget.dataset.dragging; }} onLostPointerCapture={event => { delete event.currentTarget.dataset.dragging; }} />
      <Inspector commit={selected} head={snapshot.head} onJump={jump} onClose={() => setInspectorOpen(false)} notify={notify} />
    </>}
  </main>;
}
