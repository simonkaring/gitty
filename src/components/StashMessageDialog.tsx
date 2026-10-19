import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../model/native';
import type { StashEntry } from '../model/remote';
import { Dialog } from './ui';

/** Edits a stash reflog message. Git cannot rewrite one in place, so the entry
 * is re-stored and moves to the top of the stash list. */
export function StashMessageDialog({ stash, onSave, onClose }: {
  stash: StashEntry;
  onSave: (message: string) => Promise<void>;
  onClose: () => void;
}) {
  const [message, setMessage] = useState(stash.message);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function submit() {
    if (pending || !message.trim()) return;
    setPending(true); setError('');
    try { await onSave(message.trim()); if (alive.current) onClose(); }
    catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { if (alive.current) setPending(false); }
  }
  return <Dialog title="Edit stash message" size="sm" onClose={onClose} onSubmit={() => void submit()} footer={<>
    <button type="button" className="secondary-button" onClick={onClose}>{pending ? 'Close' : 'Cancel'}</button>
    <button className="primary-button" disabled={pending || !message.trim()}>{pending ? 'Saving…' : 'Save'}</button>
  </>}>
    <p className="muted">The stash at {stash.selector} is re-stored with this message. Git cannot edit a reflog entry in place, so it moves to the top of the stash list.</p>
    <label className="field">Message<input value={message} disabled={pending} onChange={e => setMessage(e.target.value)} autoFocus /></label>
    {pending && <p className="muted" role="status">Saving… You can close this dialog; it keeps running and its result appears in this repository.</p>}
    {error && <p className="alert" role="alert">{error}</p>}
  </Dialog>;
}
