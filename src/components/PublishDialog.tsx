import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../model/native';
import { defaultRemote } from '../model/remote';
import { Dialog } from './ui';

/** First-publish flow: pushing a branch with no upstream needs an explicit
 * remote and branch name before `repository_remote_action` can set one. */
export function PublishDialog({ remotes, branch, onPublish, onClose }: {
  remotes: string[]; branch: string; onPublish: (remote: string, branch: string) => Promise<void>; onClose: () => void;
}) {
  const [remote, setRemote] = useState(() => defaultRemote(remotes));
  const [name, setName] = useState(branch);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
  return <Dialog title="Publish branch" size="sm" onClose={onClose} onSubmit={() => void submit()} footer={<>
    <button type="button" className="secondary-button" onClick={onClose}>{pending ? 'Close' : 'Cancel'}</button>
    <button className="primary-button" disabled={pending || !remote || !name.trim()}>{pending ? 'Publishing…' : 'Publish'}</button>
  </>}>
    <p className="muted">This branch has no upstream yet. Choose a remote and branch name to publish it.</p>
    {!remotes.length && <p className="alert" role="alert">No remotes are configured for this repository.</p>}
    <label className="field">Remote<select value={remote} disabled={pending} onChange={e => setRemote(e.target.value)}><option value="">Choose remote…</option>{remotes.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    <label className="field">Branch name<input value={name} disabled={pending} onChange={e => setName(e.target.value)} /></label>
    {pending && <p className="muted" role="status">Publishing… You can close this dialog; it keeps running and its result appears in this repository.</p>}
    {error && <p className="alert" role="alert">{error}</p>}
  </Dialog>;
}
