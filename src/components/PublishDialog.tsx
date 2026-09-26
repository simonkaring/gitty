import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../model/native';
import { defaultRemote } from '../model/remote';

/** First-publish flow: pushing a branch with no upstream needs an explicit
 * remote and branch name before `repository_remote_action` can set one. */
export function PublishDialog({ remotes, branch, onPublish, onClose }: {
  remotes: string[]; branch: string; onPublish: (remote: string, branch: string) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [remote, setRemote] = useState(() => defaultRemote(remotes));
  const [name, setName] = useState(branch);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; }; }, []);
  async function submit() {
    if (pending || !remote || !name.trim()) return;
    setPending(true); setError('');
    try { await onPublish(remote, name.trim()); if (alive.current) onClose(); }
    catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { if (alive.current) setPending(false); }
  }
  // Closing while pending does not cancel the publish: it keeps running in
  // the repository tab and its result (success or error) surfaces there as a
  // notice, bound to that tab, even after this dialog is gone.
  return <dialog ref={dialog} className="dialog operation-dialog publish-dialog" aria-label="Publish branch" onCancel={onClose}>
    <h2>Publish branch</h2>
    <p>This branch has no upstream yet. Choose a remote and branch name to publish it.</p>
    {pending && <p role="status">Publishing… You can close this dialog; it keeps running and its result appears in this repository.</p>}
    {!remotes.length && <p role="alert">No remotes are configured for this repository.</p>}
    <label>Remote<select value={remote} disabled={pending} onChange={e => setRemote(e.target.value)}><option value="">Choose remote…</option>{remotes.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    <label>Branch name<input value={name} disabled={pending} onChange={e => setName(e.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <button className="primary-button" disabled={pending || !remote || !name.trim()} onClick={() => void submit()}>{pending ? 'Publishing…' : 'Publish'}</button>
    <button onClick={onClose}>{pending ? 'Close' : 'Cancel'}</button>
  </dialog>;
}
