import { useEffect, useRef } from 'react';
import type { StatusEntry } from '../model/repository';
import { Dialog } from './ui';

const SHOWN = 8;

/** Confirms a discard. The caller captured the status fingerprint when it opened this,
 * so changes that land while the dialog is open are refused instead of discarded unseen. */
export function DiscardDialog({ entries, blocked, onConfirm, onClose }: { entries: StatusEntry[]; blocked: boolean; onConfirm: () => void; onClose: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  // Dialog opens itself in an effect of its own, which runs before this one.
  useEffect(() => cancel.current?.focus(), []);
  const untracked = entries.filter(entry => entry.untracked).length;
  const partial = entries.some(entry => !entry.untracked && !['.', ' '].includes(entry.indexStatus));
  const noun = `${entries.length} file${entries.length === 1 ? '' : 's'}`;
  return <Dialog title="Discard changes?" size="sm" className="discard-dialog" onClose={onClose} footer={<>
    <button type="button" ref={cancel} className="secondary-button" onClick={onClose}>Cancel</button>
    <button type="button" className="secondary-button" data-danger="true" disabled={blocked} onClick={onConfirm}>Discard {noun}</button>
  </>}>
    <p>This cannot be undone. The unstaged changes in {noun} will be thrown away.</p>
    <ul className="discard-list" aria-label="Files to discard">
      {entries.slice(0, SHOWN).map(entry => <li key={entry.path}>{entry.path}{entry.untracked && <small> · untracked, deleted</small>}</li>)}
      {entries.length > SHOWN && <li>…and {entries.length - SHOWN} more</li>}
    </ul>
    {untracked > 0 && <p className="muted">Untracked files are deleted from disk and cannot be recovered from Git.</p>}
    {partial && <p className="muted">Staged changes are kept; only the working-tree edits on top of them are discarded.</p>}
  </Dialog>;
}
