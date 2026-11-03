import { useEffect, useRef, useState } from 'react';
import { native, errorMessage } from '../model/native';
import { branchBatchDeleteRequest, folderLabel, MAX_BATCH_BRANCHES, type BranchDeleteScope, type BranchFolder, type FolderDeleteTargets } from '../model/branchDelete';
import type { BranchBatchDeleteExecution, BranchBatchDeleteOutcome, BranchBatchDeleteRequest, BranchBatchDeleteResult, BranchDeleteTargetResult } from '../model/operations';
import type { RepositoryState } from '../model/repository';
import { Dialog } from './ui';

function mergeTarget(previous: BranchDeleteTargetResult | null | undefined, next: BranchDeleteTargetResult | null) {
  if (!next) return previous ?? null;
  if (previous?.status === 'deleted' && next.status !== 'deleted') return previous;
  return next;
}

export function mergeBatchResult(previous: BranchBatchDeleteOutcome[], next: BranchBatchDeleteResult): BranchBatchDeleteOutcome[] {
  const merged = new Map(previous.map(item => [item.branch, item]));
  for (const item of next.branches) {
    const old = merged.get(item.branch);
    merged.set(item.branch, { branch: item.branch, local: mergeTarget(old?.local, item.local), origin: mergeTarget(old?.origin, item.origin) });
  }
  return [...merged.values()];
}

export function BranchFolderDeleteDialog({ state, folder, scope, targets, onClose, onComplete, onDelete }: {
  state: RepositoryState;
  folder: BranchFolder;
  scope: BranchDeleteScope;
  targets: FolderDeleteTargets;
  onClose: () => void;
  onComplete: (request: BranchBatchDeleteRequest, result: BranchBatchDeleteResult) => void;
  onDelete: (request: BranchBatchDeleteRequest) => Promise<BranchBatchDeleteExecution>;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const reviewedState = useRef(state).current;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pushUrl, setPushUrl] = useState('');
  const [ledger, setLedger] = useState<BranchBatchDeleteOutcome[]>([]);
  const [forced, setForced] = useState(false);
  const [forceConfirmed, setForceConfirmed] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const includesLocal = scope !== 'origin';
  const includesOrigin = scope !== 'local';
  const { entries, skipped } = targets;
  const tooMany = entries.length > MAX_BATCH_BRANCHES;

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

  const attempted = ledger.length > 0;
  const unmerged = includesLocal && !forced
    ? ledger.filter(item => item.local?.status === 'failed' && item.local.error?.code === 'branchNotMerged').map(item => item.branch)
    : [];
  const forceAvailable = unmerged.length > 0;

  async function submit() {
    setBusy(true);
    setError('');
    const forcing = forceAvailable;
    const selected = forcing ? entries.filter(entry => unmerged.includes(entry.branch)) : entries;
    if (forcing) setForced(true);
    try {
      const request = branchBatchDeleteRequest(reviewedState, selected, scope, { pushUrl, force: forcing ? unmerged : [] });
      const execution = await onDelete(request);
      setLedger(current => mergeBatchResult(current, execution.result));
      setRefreshError(execution.refreshError ?? '');
      onComplete(request, execution.result);
      if (execution.refreshError) setError('Refresh failed after the deletion attempt. The outcomes shown are the confirmed results; further writes remain blocked until refresh succeeds.');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const maySubmit = forceAvailable
    ? forceConfirmed
    : !attempted && entries.length > 0 && !tooMany && (!includesOrigin || !!pushUrl);
  const showSubmit = forceAvailable || !attempted;
  const noun = (n: number) => `${n} ${n === 1 ? 'branch' : 'branches'}`;
  const title = forceAvailable ? 'Confirm forced local deletion' : `Delete ${noun(entries.length)} in ${folderLabel(folder)}?`;
  const scopeLabel = scope === 'both' ? 'local and origin' : scope;
  const describe = (value: BranchDeleteTargetResult | null) => value && <span data-status={value.status}>
    {value.target === 'origin' ? 'Origin' : 'Local'}: {value.status}{value.error ? ` — ${value.error.code}: ${value.error.message}` : ''}{value.note ? ` — ${value.note}` : ''}
  </span>;

  return <Dialog title={title} onClose={onClose} size="sm" className="branch-delete-dialog" footer={<>
    <button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>{attempted ? 'Close' : 'Cancel'}</button>
    {showSubmit && <button type="button" className="danger-button" disabled={busy || !maySubmit} onClick={() => void submit()}>
      {busy ? 'Deleting…' : forceAvailable ? `Force delete ${noun(unmerged.length)} and continue` : `Confirm ${scopeLabel} deletion of ${noun(entries.length)}`}
    </button>}
  </>}>
    <p>This removes branch references and may leave commits reachable only through reflogs. Working files and index changes are left alone.</p>
    <dl className="branch-delete-review">
      <dt>Folder</dt><dd><code>{folderLabel(folder)}</code></dd>
      <dt>Scope</dt><dd>{scopeLabel}</dd>
      {includesOrigin && <><dt>Push destination</dt><dd>{pushUrl || 'Reading configured push URL…'}</dd></>}
      <dt>HEAD</dt><dd><code>{reviewedState.session.headRef ?? 'detached HEAD'}</code> · <code>{reviewedState.session.head ?? 'unborn'}</code></dd>
    </dl>
    {!attempted && <section aria-label="Branches to delete" className="branch-delete-outcomes"><strong>Branches to delete</strong><ul className="branch-folder-list">
      {entries.map(entry => <li key={entry.branch}><code>{entry.branch}</code>
        {includesLocal && <span> · local <code>{entry.localOid?.slice(0, 10)}</code></span>}
        {includesOrigin && <span> · origin <code>{entry.originOid?.slice(0, 10)}</code></span>}
      </li>)}
    </ul></section>}
    {skipped.length > 0 && !attempted && <section aria-label="Skipped branches" className="branch-delete-outcomes"><strong>Skipped</strong><ul className="branch-folder-list">
      {skipped.map(item => <li key={item.branch}><code>{item.branch}</code> — {item.reason}</li>)}
    </ul></section>}
    {tooMany && <p className="workflow-alert error" role="alert">At most {MAX_BATCH_BRANCHES} branches can be deleted at once. Delete a nested folder first.</p>}
    {forceAvailable && <>
      <p>Git refused safe local deletion of {noun(unmerged.length)} because {unmerged.length === 1 ? 'it is' : 'they are'} not fully merged. This is a separate confirmation to force only these local references{includesOrigin ? '; their origin deletion still requires the unchanged OID and lease' : ''}.</p>
      <ul className="branch-folder-list">{unmerged.map(branch => <li key={branch}><code>{branch}</code></li>)}</ul>
      <label><input type="checkbox" checked={forceConfirmed} onChange={event => setForceConfirmed(event.target.checked)} /> I understand {unmerged.length === 1 ? 'this unmerged local branch reference' : `these ${unmerged.length} unmerged local branch references`} will be removed.</label>
    </>}
    {attempted && <section aria-label="Deletion outcomes" className="branch-delete-outcomes"><strong>Deletion outcomes</strong><ul className="branch-folder-list">
      {ledger.map(item => <li key={item.branch}><code>{item.branch}</code> {describe(item.local)} {describe(item.origin)}</li>)}
    </ul></section>}
    {refreshError && <p className="workflow-alert error" role="alert">Refresh failed: {refreshError}</p>}
    {error && <p className="workflow-alert error" role="alert">{error}</p>}
  </Dialog>;
}
