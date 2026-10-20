import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Clock3, Download, Folder, FolderGit2, FolderOpen, Search, Server, SquareTerminal } from 'lucide-react';
import type { DirectoryEntry, RepositoryLocation, WslDistribution } from '../model/repository';
import { errorMessage, native } from '../model/native';
import { suggestedCloneName, type CloneRequest } from '../model/clone';
import { locationForPickedFolder } from '../model/wslPath';
import { Segmented } from './ui';
import { sshDestination, sshFailureHint, sshLocationFromForm, sshTargetFromForm, type SshLocation, type SshProbe } from '../model/ssh';
import { RepositoryBrowser } from './RepositoryBrowser';
import type { ProviderRepository } from '../model/providerRepositories';

/** Lanes for the decorative background graph: [x, fromY, toY, color var]. */
const LANES: [number, number, number, string][] = [[40, 0, 600, '--graph-lane1'], [80, 90, 420, '--graph-lane2'], [120, 200, 520, '--graph-lane3'], [160, 60, 260, '--graph-lane4']];
const NODES: [number, number, string][] = [[40, 50, '--graph-lane1'], [80, 130, '--graph-lane2'], [40, 170, '--graph-lane1'], [160, 110, '--graph-lane4'], [120, 250, '--graph-lane3'], [80, 300, '--graph-lane2'], [40, 340, '--graph-lane1'], [160, 220, '--graph-lane4'], [120, 400, '--graph-lane3'], [40, 460, '--graph-lane1'], [120, 480, '--graph-lane3'], [80, 380, '--graph-lane2']];

function GraphArt() {
  return <svg className="welcome-graph" viewBox="0 0 200 600" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
    {LANES.map(([x, y1, y2, color], i) => <path key={i} d={`M${x} ${y1} V${y2}`} style={{ stroke: `var(${color})`, animationDelay: `${i * 180}ms` }} />)}
    <path d="M80 130 C80 150 40 150 40 170" style={{ stroke: 'var(--graph-lane2)', animationDelay: '500ms' }} />
    <path d="M120 250 C120 280 80 280 80 300" style={{ stroke: 'var(--graph-lane3)', animationDelay: '700ms' }} />
    <path d="M160 220 C160 240 120 240 120 250" style={{ stroke: 'var(--graph-lane4)', animationDelay: '900ms' }} />
    {NODES.map(([x, y, color], i) => <circle key={i} cx={x} cy={y} r="5" style={{ fill: `var(${color})`, animationDelay: `${300 + i * 90}ms` }} />)}
  </svg>;
}

type View = 'recent' | 'clone' | 'wsl' | 'ssh';
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const parentPath = (path: string) => path.replace(/\/?[^/]+\/?$/, '') || '/';

/** The start page: shown with no tabs open and in every new tab. Opening a
 * repository from a tab replaces that tab (see `tabsReducer` 'open'). */
export function StartPage({ onOpen, onClone, cloneBusy }: {
  onOpen: (location: RepositoryLocation) => void; onClone: (request: CloneRequest) => void; cloneBusy: boolean;
}) {
  const [view, setView] = useState<View>('recent');
  const [recent, setRecent] = useState<RepositoryLocation[] | null>(null);
  const [filter, setFilter] = useState('');
  const [distributions, setDistributions] = useState<WslDistribution[]>([]);
  const [distribution, setDistribution] = useState('');
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cloneSource, setCloneSource] = useState('');
  const [cloneMethod, setCloneMethod] = useState<'accounts' | 'url'>('accounts');
  const [cloneAccountId, setCloneAccountId] = useState<string>();
  const [cloneName, setCloneName] = useState('');
  const [cloneKind, setCloneKind] = useState<'native' | 'wsl'>('native');
  const [nativeParent, setNativeParent] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshUser, setSshUser] = useState('');
  const [sshPort, setSshPort] = useState('');
  const [sshPath, setSshPath] = useState('');
  const [sshProbe, setSshProbe] = useState<SshProbe | null>(null);
  const [sshBusy, setSshBusy] = useState(false);
  const [sshFolders, setSshFolders] = useState<DirectoryEntry[]>([]);
  const [sshBrowsing, setSshBrowsing] = useState(false);
  const [sshBrowseBusy, setSshBrowseBusy] = useState(false);
  // One owner per request kind: a connection test must not take over a pending
  // folder listing's busy flag (or the other way round). WSL browsing and the
  // folder pickers keep their own shared counter.
  const request = useRef(0);
  const sshProbeRequest = useRef(0);
  const sshBrowseRequest = useRef(0);
  const selectRepository = useCallback((repository: ProviderRepository | null, accountId?: string) => {
    setCloneSource(repository?.cloneUrl ?? ''); setCloneName(repository?.name ?? ''); setCloneAccountId(repository ? accountId : undefined);
  }, []);
  useEffect(() => {
    let live = true;
    native<RepositoryLocation[]>('repository_recent').then(v => { if (live) setRecent(Array.isArray(v) ? v : []); }).catch(e => { if (live) { setRecent([]); setError(errorMessage(e)); } });
    // ponytail: WSL is optional; an unavailable host just hides the WSL view.
    native<WslDistribution[]>('wsl_distributions').then(v => { if (live && v.length) { setDistributions(v); setDistribution(v[0].name); } }).catch(() => {});
    return () => { live = false; request.current++; sshProbeRequest.current++; sshBrowseRequest.current++; };
  }, []);
  function show(next: View) { setView(next); setError(''); }
  async function browse(next = path) {
    const token = ++request.current; setBusy(true); setError('');
    try { const result = await native<DirectoryEntry[]>('wsl_directories', { distribution, path: next }); if (request.current === token) { setEntries(result); setPath(next); } }
    catch (e) { if (request.current === token) setError(errorMessage(e)); }
    finally { if (request.current === token) setBusy(false); }
  }
  async function pick(command: 'repository_pick' | 'repository_pick_clone_parent') {
    const token = ++request.current; setError('');
    try {
      const folder = await native<string | null>(command);
      if (!folder || token !== request.current) return;
      if (command === 'repository_pick') onOpen(locationForPickedFolder(folder)); else setNativeParent(folder);
    } catch (e) { if (token === request.current) setError(errorMessage(e)); }
  }
  function submitClone() {
    const source = cloneSource.trim();
    const directoryName = cloneName.trim() || suggestedCloneName(source);
    const parent: RepositoryLocation | null = cloneKind === 'wsl' ? distribution ? { kind: 'wsl', distribution, path } : null : nativeParent ? locationForPickedFolder(nativeParent) : null;
    if (!source || !directoryName || !parent) { setError('Enter a repository URL, choose a destination folder, and name the new folder.'); return; }
    if (cloneMethod === 'accounts' && (!cloneAccountId || parent.kind !== 'native')) { setError('Choose a repository and a native destination folder.'); return; }
    onClone({ source, parent, directoryName, ...(cloneAccountId ? { accountId: cloneAccountId } : {}) });
  }
  function sshLocation(): SshLocation | null {
    const result = sshLocationFromForm({ host: sshHost, user: sshUser, port: sshPort, path: sshPath });
    if (typeof result === 'string') { setError(result); return null; }
    setError('');
    return result;
  }
  /** A different host, user or port makes every pending SSH answer obsolete: it
   * describes a destination the form no longer names, and acting on it would show
   * folders or a successful test for the wrong machine. */
  function setSshDestination(next: { host?: string; user?: string; port?: string }) {
    if (next.host !== undefined) setSshHost(next.host);
    if (next.user !== undefined) setSshUser(next.user);
    if (next.port !== undefined) setSshPort(next.port);
    sshProbeRequest.current++; sshBrowseRequest.current++;
    setSshBusy(false); setSshBrowseBusy(false);
    setSshProbe(null); setSshFolders([]); setSshBrowsing(false);
  }
  /** Drops a probe whose path the user has since changed; the request that is
   * still in flight will finish without reporting anything. */
  function cancelSshProbe() {
    sshProbeRequest.current++;
    setSshProbe(null); setSshBusy(false);
  }
  /** A typed path makes a pending listing obsolete: its folder would replace what
   * the user just entered. */
  function setSshPathValue(value: string) {
    setSshPath(value);
    sshBrowseRequest.current++;
    setSshBrowseBusy(false); setSshBrowsing(false); setSshFolders([]);
    setSshProbe(null);
  }
  async function testSsh() {
    const location = sshLocation();
    if (!location) return;
    const token = ++sshProbeRequest.current; setSshBusy(true); setSshProbe(null);
    try {
      const probe = await native<SshProbe>('ssh_test', { target: { host: location.host, user: location.user, port: location.port, path: location.path } });
      if (token === sshProbeRequest.current) setSshProbe(probe);
    } catch (e) {
      if (token !== sshProbeRequest.current) return;
      const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : '';
      const hint = sshFailureHint(code);
      setError(hint ? `${errorMessage(e)} ${hint}` : errorMessage(e));
    } finally { if (token === sshProbeRequest.current) setSshBusy(false); }
  }
  /** Browses one directory on the host; the listing replaces the manual path. */
  async function browseSsh(next: string) {
    const target = sshTargetFromForm({ host: sshHost, user: sshUser, port: sshPort });
    if (typeof target === 'string') { setError(target); return; }
    const token = ++sshBrowseRequest.current;
    setSshBrowsing(true); setSshBrowseBusy(true); setError('');
    try {
      const folders = await native<DirectoryEntry[]>('ssh_directories', { target: { ...target, path: next } });
      if (token !== sshBrowseRequest.current) return;
      setSshFolders(folders); setSshPath(next);
      // A listing that moved the path makes a probe still in flight describe the
      // previous directory, so that answer must not be reported.
      if (next !== sshPath) cancelSshProbe();
    } catch (e) { if (token === sshBrowseRequest.current) setError(errorMessage(e)); }
    finally { if (token === sshBrowseRequest.current) setSshBrowseBusy(false); }
  }
  const views: [View, string, typeof Clock3][] = [['recent', 'Recent', Clock3], ['clone', 'Clone', Download], ['ssh', 'Open over SSH', Server], ...(distributions.length ? [['wsl', 'Browse WSL', SquareTerminal] as [View, string, typeof Clock3]] : [])];
  function navKey(event: KeyboardEvent) {
    const index = views.findIndex(([id]) => id === view);
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const [id] = views[(next + views.length) % views.length];
    show(id); requestAnimationFrame(() => document.getElementById(`start-${id}`)?.focus());
  }
  const query = filter.trim().toLowerCase();
  const shown = (recent ?? []).filter(location => !query || `${location.path} ${location.kind === 'wsl' ? location.distribution : location.kind === 'ssh' ? sshDestination(location) : ''}`.toLowerCase().includes(query));
  const alert = error && <p className="alert" role="alert">{error}</p>;

  return <main className="start-page">
    <GraphArt />
    <div className="start-card">
      <header className="start-header">
        <span className="welcome-mark"><FolderGit2 size={22} /></span>
        <div><h1>Open a repository</h1><p>See every branch as a graph, stage exactly what you mean, and commit with confidence.</p></div>
      </header>
      <div className="start-body">
        <nav className="start-nav" aria-label="Ways to open a repository">
          <button className="primary-button" onClick={() => void pick('repository_pick')}><FolderOpen size={16} />Open folder…</button>
          <div role="tablist" aria-orientation="vertical" onKeyDown={navKey}>
            {views.map(([id, label, Icon]) => <button key={id} id={`start-${id}`} role="tab" aria-selected={view === id} aria-controls="start-panel" tabIndex={view === id ? 0 : -1} onClick={() => show(id)}><Icon size={15} />{label}</button>)}
          </div>
        </nav>
        <section id="start-panel" className="start-panel" role="tabpanel" aria-labelledby={`start-${view}`}>
          {view === 'recent' && <>
            {(recent?.length ?? 0) > 5 && <label className="search-field start-filter"><Search size={14} aria-hidden="true" /><input aria-label="Filter recent repositories" placeholder="Filter recent repositories" value={filter} onChange={e => setFilter(e.target.value)} /></label>}
            {alert}
            {recent === null ? <p className="muted" role="status">Reading recent repositories…</p>
              : !recent.length ? <div className="empty-state compact"><Clock3 size={20} /><p>No recent repositories yet.<br />Open a folder or clone one to get started.</p></div>
              : !shown.length ? <p className="muted">No recent repositories match “{filter}”.</p>
              : <ul className="start-list" aria-label="Recent repositories">{shown.map(location => <li key={JSON.stringify(location)}>
                <button className="start-item" onClick={() => onOpen(location)}>
                  <FolderGit2 size={16} />
                  <span><strong>{baseName(location.path)}</strong><small>{location.path}</small></span>
                  {location.kind === 'wsl' && <span className="badge">WSL · {location.distribution}</span>}
                  {location.kind === 'ssh' && <span className="badge">SSH · {sshDestination(location)}</span>}
                </button>
              </li>)}</ul>}
          </>}
          {view === 'clone' && <div className="start-form">
            <Segmented label="Clone source" value={cloneMethod} options={[[ 'accounts', 'Connected accounts' ], [ 'url', 'Repository URL' ]]} onChange={value => { if (cloneBusy) return; setCloneMethod(value); selectRepository(null); if (value === 'accounts') setCloneKind('native'); }} />
            {cloneMethod === 'accounts' && <RepositoryBrowser disabled={cloneBusy} onSelect={selectRepository} />}
            <form className="start-form" onSubmit={event => { event.preventDefault(); submitClone(); }}>
            <label className="field">Repository URL<input autoFocus={cloneMethod === 'url'} value={cloneSource} readOnly={cloneMethod === 'accounts'} disabled={cloneBusy} onChange={event => setCloneSource(event.target.value)} onBlur={() => { if (!cloneName.trim()) setCloneName(suggestedCloneName(cloneSource)); }} placeholder={cloneMethod === 'accounts' ? 'Select a repository above' : 'https://host/team/repository.git'} /></label>
            <div className="field">
              <span>Destination</span>
              {!!distributions.length && cloneMethod === 'url' && <Segmented label="Destination type" value={cloneKind} options={[['native', 'This computer'], ['wsl', 'WSL']]} onChange={setCloneKind} />}
              {cloneKind === 'native'
                ? <div className="path-picker"><code title={nativeParent}>{nativeParent || 'No folder chosen'}</code><button type="button" className="secondary-button compact" disabled={cloneBusy} onClick={() => void pick('repository_pick_clone_parent')}>Choose…</button></div>
                : <div className="path-picker"><code>{distribution}:{path}</code><button type="button" className="secondary-button compact" onClick={() => show('wsl')}>Change…</button></div>}
            </div>
            <label className="field">Folder name<input value={cloneName} disabled={cloneBusy} onChange={event => setCloneName(event.target.value)} placeholder={suggestedCloneName(cloneSource) || 'repository'} /></label>
            <p className="muted small">{cloneMethod === 'accounts' ? 'Clones using the selected connected account. Choose a folder on this computer; WSL cloning is available through Repository URL with WSL credentials.' : 'Clones the full repository without submodules, using your configured Git credentials or SSH agent.'}</p>
            {alert}
            <div className="start-actions"><button className="primary-button" disabled={cloneBusy || !cloneSource.trim() || !(cloneKind === 'wsl' ? distribution : nativeParent)}>{cloneBusy ? 'Cloning…' : 'Clone repository'}</button></div>
          </form></div>}
          {view === 'ssh' && <div className="start-form">
            <form className="start-form" onSubmit={event => { event.preventDefault(); void testSsh(); }}>
              <label className="field">Host<input autoFocus value={sshHost} disabled={sshBusy} onChange={event => setSshDestination({ host: event.target.value })} placeholder="home, or home.tailnet.ts.net" /></label>
              <div className="field-row">
                <label className="field">User (optional)<input value={sshUser} disabled={sshBusy} onChange={event => setSshDestination({ user: event.target.value })} placeholder="uses ~/.ssh/config" /></label>
                <label className="field">Port (optional)<input inputMode="numeric" value={sshPort} disabled={sshBusy} onChange={event => setSshDestination({ port: event.target.value })} placeholder="22" /></label>
              </div>
              <div className="field">
                <span>Repository path</span>
                <div className="field-row">
                  <input className="mono" aria-label="Repository path" value={sshPath} disabled={sshBusy} onChange={event => setSshPathValue(event.target.value)} placeholder="/home/you/code/thing" />
                  <button type="button" className="secondary-button" disabled={sshBusy || sshBrowseBusy} onClick={() => void browseSsh(sshPath.trim() && sshPath.trim().startsWith('/') ? sshPath.trim() : '/')}>{sshBrowseBusy ? 'Reading…' : 'Browse…'}</button>
                </div>
              </div>
              {sshBrowsing && <div className="field">
                <span>Folders in <code className="mono">{sshPath || '/'}</code></span>
                {sshBrowseBusy ? <p className="muted small" role="status">Reading folders…</p>
                  : !sshFolders.length ? <p className="muted small">No subfolders here. Open this folder, or go up.</p>
                  : <ul className="start-list" aria-label="Remote folders">
                    {sshFolders.map(folder => <li key={folder.path}><button type="button" className="start-item" disabled={sshBrowseBusy} onClick={() => void browseSsh(folder.path)}><Folder size={16} /><span><strong>{folder.name}</strong><small>{folder.path}</small></span></button></li>)}
                  </ul>}
                <div className="start-actions">
                  {sshPath !== '/' && <button type="button" className="secondary-button" disabled={sshBrowseBusy} onClick={() => void browseSsh(parentPath(sshPath))}><ArrowUp size={14} />Parent folder</button>}
                  <button type="button" className="primary-button" disabled={sshBrowseBusy} onClick={() => setSshBrowsing(false)}>Use this folder</button>
                </div>
              </div>}
              {alert}
              {sshProbe && <p className="muted small" role="status">Connected · {sshProbe.gitVersion}{sshProbe.name ? ` · ${sshProbe.name} is a Git repository.` : ''}</p>}
              <div className="start-actions">
                <button type="submit" className="secondary-button" disabled={sshBusy}>{sshBusy ? 'Testing…' : 'Test connection'}</button>
                <button type="button" className="primary-button" disabled={sshBusy} onClick={() => { const location = sshLocation(); if (location) onOpen(location); }}>Open repository</button>
              </div>
            </form>
            <p className="muted small">Uses your own SSH configuration and keys, so nothing new is trusted or stored here. The remote host needs Git; editing conflict files there also needs python3. Cloning and opening files are not available over SSH.</p>
          </div>}
          {view === 'wsl' && <div className="start-form">
            <label className="field">Distribution<select value={distribution} onChange={e => { request.current++; setDistribution(e.target.value); setEntries([]); setPath('/'); setBusy(false); }}>{distributions.map(item => <option key={item.name}>{item.name}</option>)}</select></label>
            <form className="field" onSubmit={e => { e.preventDefault(); void browse(); }}>
              <label htmlFor="start-wsl-path">Linux path</label>
              <div className="field-row"><input id="start-wsl-path" className="mono" value={path} onChange={e => setPath(e.target.value)} /><button className="secondary-button" disabled={busy}>{busy ? 'Loading…' : 'Browse'}</button></div>
            </form>
            {alert}
            <ul className="start-list" aria-label="Folders">
              {path !== '/' && <li><button className="start-item" disabled={busy} onClick={() => void browse(parentPath(path))}><ArrowUp size={16} /><span><strong>Parent folder</strong></span></button></li>}
              {entries.map(entry => <li key={entry.path}><button className="start-item" disabled={busy} onClick={() => void browse(entry.path)}><Folder size={16} /><span><strong>{entry.name}</strong></span></button></li>)}
            </ul>
            <div className="start-actions">
              <button className="secondary-button" onClick={() => { setCloneMethod('url'); selectRepository(null); setCloneKind('wsl'); show('clone'); }}>Clone into this folder</button>
              <button className="primary-button" onClick={() => onOpen({ kind: 'wsl', distribution, path })}>Open this folder</button>
            </div>
          </div>}
        </section>
      </div>
    </div>
  </main>;
}
