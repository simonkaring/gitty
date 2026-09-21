import { useEffect, useRef, useState } from 'react';
import type { DirectoryEntry, RepositoryLocation, WslDistribution } from '../model/repository';
import { errorMessage, native } from '../model/native';

export function RepositoryPicker({ onOpen, onClose }: { onOpen: (location: RepositoryLocation) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [recent, setRecent] = useState<RepositoryLocation[]>([]);
  const [distributions, setDistributions] = useState<WslDistribution[]>([]);
  const [distribution, setDistribution] = useState('');
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [error, setError] = useState('');
  const [wslMessage, setWslMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    native<RepositoryLocation[]>('repository_recent').then(v => { if (live) setRecent(v); }).catch(e => { if (live) setError(errorMessage(e)); });
    native<WslDistribution[]>('wsl_distributions').then(v => { if (live) { setDistributions(v); setDistribution(v[0]?.name ?? ''); if (!v.length) setWslMessage('No WSL distributions available on this host.'); } }).catch(e => { if (live) setWslMessage(`WSL unavailable: ${errorMessage(e)}`); });
    return () => { live = false; request.current++; };
  }, []);
  async function browse(next = path) {
    const token = ++request.current; setBusy(true); setError('');
    try { const result = await native<DirectoryEntry[]>('wsl_directories', { distribution, path: next }); if (request.current === token) { setEntries(result); setPath(next); } }
    catch (e) { if (request.current === token) setError(errorMessage(e)); }
    finally { if (request.current === token) setBusy(false); }
  }
  async function pick() {
    const token = ++request.current;
    setError('');
    try { const folder = await native<string | null>('repository_pick'); if (folder && token === request.current) onOpen({ kind: 'native', path: folder }); }
    catch (e) { if (token === request.current) setError(errorMessage(e)); }
  }
  return <dialog ref={dialog} className="dialog native-picker" aria-label="Open repository" onCancel={onClose}>
    <div className="native-actions"><h2>Open repository</h2><button onClick={onClose} aria-label="Close repository picker">Close</button></div>
    <button onClick={() => void pick()}>Choose native folder…</button>
    <h3>Recent repositories</h3><div className="native-recent">{recent.map(location => <button key={JSON.stringify(location)} onClick={() => onOpen(location)}><strong>{location.kind === 'wsl' ? `WSL · ${location.distribution}` : 'Native'}</strong> {location.path}</button>)}{!recent.length && <p>No recent repositories.</p>}</div>
    {!!distributions.length && <><h3>Browse WSL</h3><label>Distribution <select value={distribution} onChange={e => { request.current++; setDistribution(e.target.value); setEntries([]); setPath('/'); setBusy(false); }}>{distributions.map(item => <option key={item.name}>{item.name}</option>)}</select></label><form onSubmit={e => { e.preventDefault(); void browse(); }}><label>Linux path <input value={path} onChange={e => setPath(e.target.value)} /></label><button disabled={busy}>Browse</button></form><div className="native-recent"><button disabled={busy} onClick={() => void browse(path.replace(/\/?[^/]+\/?$/, '') || '/')}>Parent folder</button>{entries.map(entry => <button key={entry.path} disabled={busy} onClick={() => void browse(entry.path)}>{entry.name}/</button>)}</div><button onClick={() => onOpen({ kind: 'wsl', distribution, path })}>Open this WSL folder</button></>}
    {wslMessage && <p>{wslMessage}</p>}{busy && <p role="status">Loading folders…</p>}{error && <p role="alert">{error}</p>}
  </dialog>;
}
