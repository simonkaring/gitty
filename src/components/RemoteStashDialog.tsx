import { useEffect, useRef, useState } from 'react';
import { native, errorMessage } from '../model/native';
import { describeStashAction, sortStashes, type StashActionRequest, type StashEntry } from '../model/remote';
import './workspace-tabs.css';

export function RemoteStashDialog({ handle, onWrite, onClose, notify }: {
  handle: string; onWrite: (command: string, args: Record<string, unknown>) => Promise<string>; onClose: () => void; notify: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmingOid, setConfirmingOid] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let live = true; setLoading(true); setError('');
    native<StashEntry[]>('repository_stashes', { handle }).then(values => { if (live) setStashes(sortStashes(values)); }).catch(e => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [handle, retry]);
  async function run(action: StashActionRequest, key: string): Promise<boolean> {
    if (pending) return false;
    setPending(key); setError(''); setConfirmingOid(null);
    try { const output = await onWrite('repository_stash_action', { action }); notify(output || `${describeStashAction(action)} complete.`); if (alive.current) setRetry(value => value + 1); return true; }
    catch (e) { if (alive.current) setError(errorMessage(e)); return false; }
    finally { if (alive.current) setPending(null); }
  }
  async function save() {
    const ok = await run({ kind: 'save', ...(message.trim() ? { message: message.trim() } : {}), includeUntracked }, 'save');
    if (ok && alive.current) setMessage('');
  }
  function requestDrop(oid: string) {
    if (confirmingOid === oid) { void run({ kind: 'drop', oid }, `drop:${oid}`); return; }
    setConfirmingOid(oid);
  }
  // Closing while an action is pending does not cancel it: the write keeps
  // running against this repository and its result (or error) still surfaces
  // here as a notice, bound to this tab, whether or not the dialog is open.
  return <dialog ref={dialog} className="dialog operation-dialog" aria-label="Stashes" onCancel={onClose}>
    <h2>Stash</h2>
    <p>Save working changes aside, or apply, pop, or drop a saved stash. Stash operations run locally only.</p>
    {pending && <p role="status">You can close this dialog; the action keeps running and its result appears in this repository.</p>}
    <label>Message (optional)<input value={message} disabled={!!pending} onChange={e => setMessage(e.target.value)} placeholder="Work in progress" /></label>
    <label><input type="checkbox" checked={includeUntracked} disabled={!!pending} onChange={e => setIncludeUntracked(e.target.checked)} /> Include untracked files</label>
    <button className="primary-button" disabled={!!pending} onClick={() => void save()}>{pending === 'save' ? 'Saving stash…' : 'Save stash'}</button>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">Reading stashes…</p> : <>
      {!stashes.length && <p className="stash-empty">No stashes.</p>}
      <ul className="stash-list">
        {stashes.map(stash => <li key={stash.oid} className="stash-entry">
          <div className="stash-entry-message"><span className="stash-entry-selector">{stash.selector}</span><br />{stash.message}</div>
          <div className="stash-entry-actions">
            <button disabled={!!pending} onClick={() => void run({ kind: 'apply', oid: stash.oid }, `apply:${stash.oid}`)}>{pending === `apply:${stash.oid}` ? 'Applying…' : 'Apply'}</button>
            <button disabled={!!pending} onClick={() => void run({ kind: 'pop', oid: stash.oid }, `pop:${stash.oid}`)}>{pending === `pop:${stash.oid}` ? 'Popping…' : 'Pop'}</button>
            <button data-danger="true" disabled={!!pending} onClick={() => requestDrop(stash.oid)}>{pending === `drop:${stash.oid}` ? 'Dropping…' : confirmingOid === stash.oid ? 'Confirm drop' : 'Drop'}</button>
          </div>
        </li>)}
      </ul>
    </>}
    {!loading && !stashes.length && !error && <button onClick={() => setRetry(value => value + 1)}>Reload stashes</button>}
    <button onClick={onClose}>Close</button>
  </dialog>;
}
