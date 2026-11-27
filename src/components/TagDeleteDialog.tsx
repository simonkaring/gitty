import { useRef, useState } from 'react';
import { Dialog } from './ui';
import { errorMessage } from '../model/native';
import { captureOperation } from '../model/operationFlow';
import type { RepositoryRef } from '../model/repository';
import type { OperationWrite } from './OperationDialog';

/** Origin first: its lease compares against the local tag, which must still exist. */
export function TagDeleteDialog({ handle, tag, hasOrigin, busy, onRemoteWrite, onWrite, onClose, onComplete }: {
  handle: string; tag: RepositoryRef; hasOrigin: boolean; busy: boolean;
  onRemoteWrite: (command: string, args: Record<string, unknown>) => Promise<string>;
  onWrite: OperationWrite; onClose: () => void; onComplete: (notice: string) => void;
}) {
  const [origin, setOrigin] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  async function execute() {
    if (busy || inFlight.current) return;
    inFlight.current = true; setPending(true); setError('');
    let originDeleted = false;
    try {
      if (origin) {
        await onRemoteWrite('repository_remote_action', { action: { kind: 'deleteRemoteTag', remote: 'origin', tag: tag.name, expectedOid: tag.commitId } });
        originDeleted = true;
      }
      const request = await captureOperation(handle, { kind: 'deleteTag', name: tag.name, expectedOid: tag.commitId });
      await onWrite('repository_run_operation', { request });
      onComplete(originDeleted ? `Deleted tag ${tag.name} locally and on origin.` : `Deleted tag ${tag.name}.`);
    } catch (e) {
      // A retry must not repeat the origin delete: its lease would now fail.
      if (originDeleted) setOrigin(false);
      setError(`${originDeleted ? `Tag ${tag.name} was deleted on origin, but not locally. Delete tag retries only the local tag. ` : ''}${errorMessage(e)}`);
    } finally { inFlight.current = false; setPending(false); }
  }
  return <Dialog title={`Delete tag ${tag.name}?`} size="sm" onClose={() => { if (!pending) onClose(); }} footer={<>
    <span className="spacer" />
    <button autoFocus className="secondary-button" disabled={pending} onClick={onClose}>Cancel</button>
    <button className="danger-button" disabled={pending || busy} onClick={() => void execute()}>{pending ? 'Deleting…' : 'Delete tag'}</button>
  </>}>
    <p>Tag <strong>{tag.name}</strong> on commit <code>{tag.commitId.slice(0, 12)}</code>. Commits and branches are not affected.</p>
    {hasOrigin && <label className="check"><input type="checkbox" checked={origin} disabled={pending} onChange={e => setOrigin(e.target.checked)} /> Also delete it on origin</label>}
    {origin && <p className="muted small">Origin's tag is deleted only while it matches this local tag.</p>}
    {error && <p className="alert" role="alert">{error}</p>}
  </Dialog>;
}
