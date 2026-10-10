import { useEffect, useRef, useState } from 'react';
import { Dialog } from './ui';
import { native, errorMessage } from '../model/native';
import { captureOperation } from '../model/operationFlow';
import type { OperationRequest } from '../model/operations';
import type { RepositorySnapshot } from '../model/repository';
import type { OperationWrite } from './OperationDialog';

interface Review { request: OperationRequest; localCommits: number; changedFiles: number }

export function OriginResetDialog({ handle, branch, busy, onWrite, onClose, onComplete }: {
  handle: string; branch: string; busy: boolean; onWrite: OperationWrite; onClose: () => void; onComplete: () => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(false);
  const inFlight = useRef(false);
  const name = branch.replace(/^refs\/remotes\/origin\//, '');
  async function capture() {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setReview(null); setError('');
    try {
      const snapshot = await native<RepositorySnapshot>('repository_snapshot', { handle });
      const tip = snapshot.state.refs.find(ref => ref.fullName === branch && ref.kind === 'remote');
      if (!tip) throw new Error('The origin branch no longer exists. Refresh the repository.');
      const [localCommits] = await native<[number, number]>('repository_branch_relation', { handle, first: snapshot.state.session.head, second: tip.commitId });
      const request = await captureOperation(handle, { kind: 'resetToOrigin', branch, expectedOriginOid: tip.commitId });
      if (request.expectedOperation !== snapshot.operation.fingerprint) throw new Error('Repository changed during review. Review again.');
      if (live.current) setReview({ request, localCommits, changedFiles: snapshot.status.entries.filter(entry => !entry.untracked).length });
    } catch (e) { if (live.current) setError(errorMessage(e)); }
    finally { inFlight.current = false; if (live.current) setPending(false); }
  }
  useEffect(() => { live.current = true; void capture(); return () => { live.current = false; }; }, []);
  async function execute() {
    if (!review || busy || inFlight.current) return;
    inFlight.current = true; setPending(true); setError('');
    try {
      await onWrite('repository_run_operation', { request: review.request });
      if (live.current) onComplete();
    } catch (e) { if (live.current) { setError(errorMessage(e)); setReview(null); } }
    finally { inFlight.current = false; if (live.current) setPending(false); }
  }
  const close = () => { if (!pending || !review) onClose(); };
  return <Dialog title={`Reset ${name} to origin/${name}?`} size="sm" onClose={close} footer={<>
    <span className="spacer" />
    <button autoFocus className="secondary-button" disabled={pending && !!review} onClick={close}>Cancel</button>
    {review ? <button className="danger-button" disabled={pending || busy} onClick={() => void execute()}>{pending ? 'Resetting…' : 'Reset branch'}</button> : <button className="secondary-button" disabled={pending || busy} onClick={() => void capture()}>{pending ? 'Reviewing…' : 'Review again'}</button>}
  </>}>
    <p className="alert" data-tone="red">This moves the local branch to origin and discards all staged and unstaged tracked changes. Discarded working changes cannot be recovered through Gitty.</p>
    {review && <>
      <p><strong>{review.localCommits}</strong> {review.localCommits === 1 ? 'commit will' : 'commits will'} be removed from this local branch.</p>
      <p><strong>{review.changedFiles}</strong> changed tracked {review.changedFiles === 1 ? 'file' : 'files'} will be reset.</p>
      <p>Destination: <strong>origin/{name}</strong> at <code>{review.request.action.kind === 'resetToOrigin' && review.request.action.expectedOriginOid.slice(0, 12)}</code>.</p>
    </>}
    <p className="muted">Uses the locally fetched origin tip. No fetch or push is performed. Untracked and ignored files are preserved; reset is refused if they would be overwritten.</p>
    {error && <p className="alert" role="alert">{error}</p>}
  </Dialog>;
}
