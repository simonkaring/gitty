import { useEffect, useRef, useState } from 'react';
import { native, errorMessage } from '../model/native';
import { branchDeleteRequest, branchDeleteTargets, type BranchDeleteScope } from '../model/branchDelete';
import type { BranchDeleteExecution, BranchDeleteRequest, BranchDeleteResult } from '../model/operations';
import type { RepositoryState } from '../model/repository';
import { Dialog } from './ui';

type Targets = NonNullable<ReturnType<typeof branchDeleteTargets>>;
const emptyResult: BranchDeleteResult = { local: null, origin: null };

function mergeResult(previous: BranchDeleteResult, next: BranchDeleteResult): BranchDeleteResult {
  const merge = (oldValue: BranchDeleteResult['local'], newValue: BranchDeleteResult['local']) => {
    if (!newValue) return oldValue;
    if (oldValue?.status === 'deleted' && newValue.status !== 'deleted') return oldValue;
    return newValue;
  };
  return { local: merge(previous.local, next.local), origin: merge(previous.origin, next.origin) };
}

export function BranchDeleteDialog({ state, target, scope, onClose, onComplete, onDelete }: {
  state: RepositoryState;
  target: Targets;
  scope: BranchDeleteScope;
  onClose: () => void;
  onComplete: (result: BranchDeleteResult) => void;
  onDelete: (request: BranchDeleteRequest) => Promise<BranchDeleteExecution>;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const reviewedState = useRef(state).current;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forceAvailable, setForceAvailable] = useState(false);
  const [forceConfirmed, setForceConfirmed] = useState(false);
  const [pushUrl, setPushUrl] = useState('');
  const [ledger, setLedger] = useState<BranchDeleteResult>(emptyResult);
  const [refreshError, setRefreshError] = useState('');
  const includesLocal = scope !== 'origin';
  const includesOrigin = scope !== 'local';

  useEffect(() => cancel.current?.focus(), []);
  useEffect(() => {
    if (!includesOrigin) return;
    let live = true;
    void native<Array<{ name: string; pushUrl: string }>>('repository_remotes', { handle: state.session.handle }).then(remotes => {
      const remote = remotes.find(item => item.name === 'origin');
      if (!remote) throw new Error('The origin remote is no longer configured.');
      if (live) setPushUrl(remote.pushUrl);
    }).catch(reason => { if (live) setError(errorMessage(reason)); });
    return () => { live = false; };
  }, [includesOrigin, state.session.handle]);

  async function submit() {
    setBusy(true);
    setError('');
    const forcing = forceAvailable;
    setForceAvailable(false);
    try {
      const execution = await onDelete(branchDeleteRequest(reviewedState, target, {
        local: includesLocal,
        origin: includesOrigin,
        forceLocal: forcing && forceConfirmed,
        pushUrl,
      }));
      const combined = mergeResult(ledger, execution.result);
      setLedger(combined);
      setRefreshError(execution.refreshError ?? '');
      onComplete(combined);
      if (!forcing && execution.result.local?.error?.code === 'branchNotMerged') {
        setForceAvailable(true);
        setForceConfirmed(false);
      } else if (execution.refreshError) {
        setError('Refresh failed after the deletion attempt. The outcomes shown are the confirmed results; further writes remain blocked until refresh succeeds.');
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const safeComplete = (!includesLocal || ledger.local?.status === 'deleted')
    && (!includesOrigin || ledger.origin?.status === 'deleted');
  const maySubmit = forceAvailable
    ? forceConfirmed
    : !ledger.local && !ledger.origin && (!includesOrigin || !!pushUrl) && (includesLocal || includesOrigin);
  const title = forceAvailable ? 'Confirm forced local deletion' : `Delete ${target.branch}?`;
  const renderOutcome = (value: BranchDeleteResult['local']) => value && <li key={value.target} data-status={value.status}>
    <strong>{value.target === 'origin' ? 'Origin' : 'Local'}: {value.status}</strong>
    {value.error && <span> — {value.error.code}: {value.error.message}</span>}
    {value.note && <span> — {value.note}</span>}
  </li>;

  return <Dialog title={title} onClose={onClose} size="sm" className="branch-delete-dialog" footer={<>
    <button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>{ledger.local || ledger.origin ? 'Close' : 'Cancel'}</button>
    {!safeComplete && maySubmit && <button type="button" className="danger-button" disabled={busy || (forceAvailable && !forceConfirmed)} onClick={() => void submit()}>
      {busy ? 'Deleting…' : forceAvailable ? 'Force delete and continue' : `Confirm ${scope === 'both' ? 'both' : scope === 'origin' ? 'origin' : 'local'} deletion`}
    </button>}
  </>}>
    <p>This removes branch references and may leave commits reachable only through reflogs. Working files and index changes are left alone.</p>
    <dl className="branch-delete-review">
      <dt>Branch</dt><dd><code>{target.branch}</code></dd>
      {includesLocal && <><dt>Local tip</dt><dd><code>{target.localOid ?? 'unavailable'}</code></dd></>}
      {includesOrigin && <><dt>Origin tip</dt><dd><code>{target.originOid ?? 'unavailable'}</code></dd><dt>Push destination</dt><dd>{pushUrl || 'Reading configured push URL…'}</dd></>}
      <dt>HEAD</dt><dd><code>{reviewedState.session.headRef ?? 'detached HEAD'}</code> · <code>{reviewedState.session.head ?? 'unborn'}</code></dd>
    </dl>
    {forceAvailable && <>
      <p>Git refused safe local deletion because the branch is not fully merged. This is a separate confirmation to force only the local reference; the selected origin deletion still requires its unchanged OID and lease.</p>
      <label><input type="checkbox" checked={forceConfirmed} onChange={event => setForceConfirmed(event.target.checked)} /> I understand the unmerged local branch reference will be removed.</label>
    </>}
    {(ledger.local || ledger.origin) && <section aria-label="Deletion outcomes" className="branch-delete-outcomes"><strong>Deletion outcomes</strong><ul>{renderOutcome(ledger.local)}{renderOutcome(ledger.origin)}</ul></section>}
    {refreshError && <p className="workflow-alert error" role="alert">Refresh failed: {refreshError}</p>}
    {error && <p className="workflow-alert error" role="alert">{error}</p>}
  </Dialog>;
}
