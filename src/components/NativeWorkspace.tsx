import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { layoutHistory } from '../graph/layout';
import type { CommitSummary, HistoryPage, RepositoryLocation, RepositoryState, RepositoryStatus, SearchResult } from '../model/repository';
import { appendUnique, errorMessage, graphCommit, native, readNativeSnapshot, validateHistory, WORKING_ID } from '../model/native';
import { HistoryGraph, type GraphAnchor, type GraphHandle } from './HistoryGraph';
import { NativeInspector } from './NativeInspector';
import { RepositoryPicker } from './RepositoryPicker';

export function NativeWorkspace({ onDemo }: { onDemo: () => void }) {
  const [state, setState] = useState<RepositoryState | null>(null);
  const [status, setStatus] = useState<RepositoryStatus | null>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [location, setLocation] = useState<RepositoryLocation | null>(null);
  const [revision, setRevision] = useState(0);
  const [theme, setTheme] = useState(() => {
    try { const saved = localStorage.getItem('gitty:theme'); if (saved === 'dark' || saved === 'light') return saved; } catch { /* Storage may be disabled. */ }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
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
  useEffect(() => { revealToken.current++; }, [selected]);
  const close = (handle: string) => native('repository_close', { handle }).catch(() => {});
  useEffect(() => () => { epoch.current++; revealToken.current++; if (session.current) void close(session.current.session.handle); session.current = null; }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('gitty:theme', theme); } catch { /* Storage may be disabled. */ } }, [theme]);
  function installHistory(items: CommitSummary[], next: string | null) { history.current = items; nextCursor.current = next; setCommits(items); setCursor(next); }
  async function open(next: RepositoryLocation) {
    const token = ++epoch.current; revealToken.current++; setLocation(next); setPicker(false); setBusy(true); setError(''); lock.current = true;
    const old = session.current; session.current = null; setState(null); setStatus(null); installHistory([], null); setBase(''); setTarget(''); setSelected('');
    if (old) void close(old.session.handle);
    let opened: RepositoryState | null = null;
    try {
      opened = await native<RepositoryState>('repository_open', { location: next });
      if (token !== epoch.current) { void close(opened.session.handle); return; }
      const handle = opened.session.handle;
      const snapshot = await readNativeSnapshot(handle, { current: () => token === epoch.current });
      if (token !== epoch.current) { void close(handle); return; }
      session.current = snapshot.state; setState(snapshot.state); setStatus(snapshot.status); fingerprint.current = snapshot.status.fingerprint; generation.current = snapshot.generation;
      installHistory(snapshot.commits, snapshot.cursor); setSelected(snapshot.state.session.head ?? (snapshot.status.entries.length ? WORKING_ID : snapshot.commits[0]?.id ?? '')); setRevision(value => value + 1);
    } catch (e) { if (opened) void close(opened.session.handle); if (token === epoch.current) setError(errorMessage(e)); }
    finally { if (token === epoch.current) { lock.current = false; setBusy(false); } }
  }
  const refresh = useCallback(async () => {
    const current = session.current;
    if (!current || lock.current) return;
    const token = epoch.current; lock.current = true;
    try {
      const handle = current.session.handle;
      const snapshot = await readNativeSnapshot(handle, {
        previous: { state: current, commits: history.current, cursor: nextCursor.current, generation: generation.current },
        preserve: [selectedRef.current, graph.current?.anchor()?.id ?? ''],
        current: () => token === epoch.current,
      });
      if (token !== epoch.current) return;
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
      if (changed) setState(updated);
      if (changed || workingChanged) setStatus(working);
      fingerprint.current = working.fingerprint;
      if (changed || workingChanged) setRevision(value => value + 1);
      setError('');
    } catch (e) { if (token === epoch.current) setError(errorMessage(e)); }
    finally { if (token === epoch.current) lock.current = false; }
  }, []);
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000); const focus = () => void refresh(); window.addEventListener('focus', focus); return () => { clearInterval(timer); window.removeEventListener('focus', focus); }; }, [refresh]);
  async function load(reveal?: string) {
    if (!session.current || lock.current) return;
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
    if (id === WORKING_ID || history.current.some(commit => commit.id === id)) { setSelected(id); jumpTo.current = id; setCommits(items => [...items]); }
    else void load(id);
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
    const keyboard = (event: KeyboardEvent) => { if (document.querySelector('dialog[open]')) return; const editable = event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName); if ((event.key === '/' && !editable) || ((event.metaKey || event.ctrlKey) && event.key === 'k')) { event.preventDefault(); search.current?.focus(); } };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, []);
  return <div className="app-shell native-shell"><header className="titlebar"><div className="brand">gitty<span className="local-badge">READ ONLY</span></div><div className="native-actions"><button onClick={() => setPicker(true)}>Open repository…</button><button onClick={onDemo}>Demo mode</button><button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>Use {theme === 'dark' ? 'light' : 'dark'} theme</button><button disabled={busy || !state} onClick={() => void refresh()}>Refresh</button></div></header>
    {error && <div className="native-banner" role="alert">{error} <button disabled={busy} onClick={() => state ? void refresh() : location && void open(location)}>Retry</button></div>}
    {busy && !state && <div className="native-banner" role="status">Loading repository…</div>}{notice && <div className="native-banner" role="status">{notice}</div>}
    {state && selected && selected !== WORKING_ID && !commits.some(commit => commit.id === selected) && <div className="native-banner" role="status">Selected commit {selected.slice(0, 12)} is {cursor ? 'outside the loaded history' : 'no longer reachable from the current references'}. Its inspector remains open by object ID.{cursor && <button disabled={busy} onClick={() => reveal(selected)}>Reveal selected commit</button>}</div>}
    {!state ? <main className="native-welcome"><h1>Explore a local repository.</h1><p>Read-only history, working changes, and comparisons. Repository data stays on this machine.</p><button disabled={busy} onClick={() => setPicker(true)}>Open repository</button><button onClick={onDemo}>Explore the labeled demo</button></main> : <main className="workspace">
      <aside className="sidebar native-sidebar" aria-label="Repository references"><h3>References</h3>{state.refs.map(ref => <button key={ref.fullName} disabled={busy} onClick={() => reveal(ref.commitId)}><small>{ref.kind}</small> {ref.name}</button>)}{state.remotes.length > 0 && <><h3>Remotes</h3>{state.remotes.map(remote => <p key={remote}>{remote}</p>)}</>}</aside>
      <section className="history-pane" aria-label="Repository history"><div className="repository-heading"><div><h1>{state.session.name}</h1><p>{state.session.root}</p></div><span className="local-badge">{state.session.location.kind === 'wsl' ? `WSL · ${state.session.location.distribution}` : 'NATIVE'}</span></div><div className="native-repo-meta">{state.session.headRef ?? 'Detached / unborn HEAD'}{state.session.linkedWorktree && ' · Linked worktree'}{state.session.bare && ' · Bare repository'}{state.session.shallow && ' · Shallow clone'}</div>
      <div className="native-filters"><input ref={search} aria-label="Search full history" placeholder="Search messages, authors, hashes, refs…" value={text} onChange={e => setText(e.target.value)} /><select aria-label="Branch scope" value={branch} onChange={e => setBranch(e.target.value)}><option value="">All branches</option>{state.refs.map(ref => <option key={ref.fullName} value={ref.fullName}>{ref.name}</option>)}</select><label>Since <input type="date" value={since} onChange={e => setSince(e.target.value)} /></label><label>Until <input type="date" value={until} onChange={e => setUntil(e.target.value)} /></label><input aria-label="Filter path" placeholder="Path filter" value={path} onChange={e => setPath(e.target.value)} /><button onClick={() => { setText(''); setBranch(''); setSince(''); setUntil(''); setPath(''); }}>Clear filters</button><button disabled={busy || !state.session.head} onClick={() => state.session.head && reveal(state.session.head)}>HEAD</button></div>
      {filtering && <div className="native-search-results"><p role="status">{searchBusy ? 'Searching full history…' : `${result?.commits.length ?? 0} matches${result?.truncated ? ' · Results truncated; narrow the query' : ''}`} · Ancestry preserved</p>{searchError && <p role="alert">{searchError} <button onClick={() => setSearchRetry(value => value + 1)}>Retry search</button></p>}<div>{result?.commits.map(commit => <button key={commit.id} disabled={busy} onClick={() => reveal(commit.id)}>{commit.id.slice(0, 7)} {commit.subject}</button>)}</div></div>}
      {!graphCommits.length && <p className="native-banner">This repository has no commits or working changes.</p>}
      <HistoryGraph ref={graph} commits={graphCommits} layout={layout} refs={state.refs} selectedId={selected} head={state.session.head ?? ''} loaded={graphCommits.length} matches={matches} onSelect={setSelected} onLoadMore={() => void load()} onOpenDetails={() => document.querySelector<HTMLElement>('.native-inspector button')?.focus()} theme={theme} hasMore={!!cursor} paging={busy} shallow={state.session.shallow} />
      <div className="native-repo-meta">{cursor ? 'Unloaded ancestry continues below. Load older history to reveal parents.' : state.session.shallow ? 'Shallow boundary: earlier ancestry is unavailable locally.' : 'End of available history.'}</div></section>
      <NativeInspector key={state.session.handle} session={state.session} selected={selected} status={status} revision={revision} base={base} target={target} onJump={reveal} onBase={() => setBase(selected)} onTarget={() => setTarget(selected)} onSwap={() => { setBase(target); setTarget(base); }} onClear={() => { setBase(''); setTarget(''); }} />
    </main>}
    <footer className="statusbar"><span>Native read-only exploration · refresh every 5 seconds and on focus</span><span>{state ? `${commits.length} commits loaded` : 'No repository open'}</span></footer>
    {picker && <RepositoryPicker onOpen={next => void open(next)} onClose={() => setPicker(false)} />}
  </div>;
}
