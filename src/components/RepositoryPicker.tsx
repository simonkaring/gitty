import { useEffect, useRef, useState } from 'react';
import type { DirectoryEntry, RepositoryLocation, WslDistribution } from '../model/repository';
import { errorMessage, native } from '../model/native';
import { suggestedCloneName, type CloneRequest } from '../model/clone';

export function RepositoryPicker({ onOpen, onClone, cloneBusy, onClose }: { onOpen: (location: RepositoryLocation) => void; onClone: (request: CloneRequest) => void; cloneBusy: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [recent, setRecent] = useState<RepositoryLocation[]>([]);
  const [distributions, setDistributions] = useState<WslDistribution[]>([]);
  const [distribution, setDistribution] = useState('');
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [error, setError] = useState('');
  const [wslMessage, setWslMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [cloneSource, setCloneSource] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [cloneKind, setCloneKind] = useState<'native' | 'wsl'>('native');
  const [nativeParent, setNativeParent] = useState('');
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
  async function pickCloneParent() {
    const token = ++request.current;
    setError('');
    try { const folder = await native<string | null>('repository_pick_clone_parent'); if (folder && token === request.current) setNativeParent(folder); }
    catch (e) { if (token === request.current) setError(errorMessage(e)); }
  }
  function submitClone(event: React.FormEvent) {
    event.preventDefault();
    const source = cloneSource.trim();
    const directoryName = cloneName.trim() || suggestedCloneName(source);
    const parent: RepositoryLocation | null = cloneKind === 'wsl'
      ? distribution ? { kind: 'wsl', distribution, path } : null
      : nativeParent ? { kind: 'native', path: nativeParent } : null;
    if (!source || !directoryName || !parent) { setError('Choose a clone source, destination folder, and directory name.'); return; }
    onClone({ source, parent, directoryName });
  }
  return <dialog ref={dialog} className="dialog native-picker" aria-label="Open repository" onCancel={onClose}>
    <div className="native-actions"><h2>Open repository</h2><button onClick={onClose} aria-label="Close repository picker">Close</button></div>
    <button onClick={() => void pick()}>Choose native folder…</button>
    <h3>Recent repositories</h3><div className="native-recent">{recent.map(location => <button key={JSON.stringify(location)} onClick={() => onOpen(location)}><strong>{location.kind === 'wsl' ? `WSL · ${location.distribution}` : 'Native'}</strong> {location.path}</button>)}{!recent.length && <p>No recent repositories.</p>}</div>
    {!!distributions.length && <><h3>Browse WSL</h3><label>Distribution <select value={distribution} onChange={e => { request.current++; setDistribution(e.target.value); setEntries([]); setPath('/'); setBusy(false); }}>{distributions.map(item => <option key={item.name}>{item.name}</option>)}</select></label><form onSubmit={e => { e.preventDefault(); void browse(); }}><label>Linux path <input value={path} onChange={e => setPath(e.target.value)} /></label><button disabled={busy}>Browse</button></form><div className="native-recent"><button disabled={busy} onClick={() => void browse(path.replace(/\/?[^/]+\/?$/, '') || '/')}>Parent folder</button>{entries.map(entry => <button key={entry.path} disabled={busy} onClick={() => void browse(entry.path)}>{entry.name}/</button>)}</div><button onClick={() => onOpen({ kind: 'wsl', distribution, path })}>Open this WSL folder</button></>}
    <section className="clone-form-section" aria-labelledby="clone-heading"><h3 id="clone-heading">Clone repository</h3><p>Clone a full repository without submodules, using your configured Git credentials or SSH agent.</p><form onSubmit={submitClone}>
      <label>Repository URL or path<input value={cloneSource} disabled={cloneBusy} onChange={event => setCloneSource(event.target.value)} onBlur={() => { if (!cloneName.trim()) setCloneName(suggestedCloneName(cloneSource)); }} placeholder="https://host/team/repository.git" /></label>
      <label>Destination type<select value={cloneKind} disabled={cloneBusy} onChange={event => setCloneKind(event.target.value as 'native' | 'wsl')}><option value="native">Native</option>{!!distributions.length && <option value="wsl">WSL</option>}</select></label>
      {cloneKind === 'native' ? <div className="clone-parent"><span>{nativeParent || 'No destination folder selected'}</span><button type="button" disabled={cloneBusy} onClick={() => void pickCloneParent()}>Choose destination folder…</button></div> : <p>WSL destination: {distribution}:{path}</p>}
      <label>New directory name<input value={cloneName} disabled={cloneBusy} onChange={event => setCloneName(event.target.value)} placeholder="repository" /></label>
      <button className="primary-button" disabled={cloneBusy || !cloneSource.trim() || !(cloneKind === 'wsl' ? distribution && path : nativeParent)}>Clone repository</button>
    </form></section>
    {wslMessage && <p>{wslMessage}</p>}{busy && <p role="status">Loading folders…</p>}{error && <p role="alert">{error}</p>}
  </dialog>;
}
