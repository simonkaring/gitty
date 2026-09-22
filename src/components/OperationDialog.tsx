import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../model/native';
import type { GitAction, OperationRequest, OperationState } from '../model/operations';
import type { CommitSummary, RepositoryState } from '../model/repository';
import { actionReason, moveCommit } from '../model/operationUi';
import { captureOperation } from '../model/operationFlow';
import '../operations.css';

export interface ActionContext { oid: string; ref?: string; initial?: GitAction['kind']; commits?: string[] }
export type OperationWrite = (command: string, args: Record<string, unknown>) => Promise<void>;

export function OperationDialog({ state, operation, context, commits, busy, onWrite, onCompare, onPullRequest, onClose }: {
  state: RepositoryState; operation: OperationState | null; context: ActionContext; commits: CommitSummary[]; busy: boolean;
  onWrite: OperationWrite; onCompare: (source: string) => void; onPullRequest: (source: string) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<GitAction['kind']>(context.initial ?? (context.ref ? context.ref === state.session.headRef ? 'createBranch' : 'merge' : 'cherryPick'));
  const [source, setSource] = useState(context.ref ?? context.oid);
  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [noFastForward, setNoFastForward] = useState(false);
  const [message, setMessage] = useState('');
  const [order, setOrder] = useState(context.commits?.length ? context.commits : [context.oid].filter(Boolean));
  const [mainline, setMainline] = useState('');
  const [review, setReview] = useState<OperationRequest | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState('');
  const live = useRef(true);
  useEffect(() => { live.current = true; dialog.current?.showModal(); return () => { live.current = false; }; }, []);
  let action: GitAction;
  switch (kind) {
    case 'createBranch': action = { kind, name, startPoint: source, checkout }; break;
    case 'switchBranch': action = { kind, branch: source }; break;
    case 'merge': action = { kind, source, noFastForward }; break;
    case 'rebase': action = { kind, onto: source }; break;
    case 'createTag': action = { kind, name, oid: context.oid, ...(message ? { message } : {}) }; break;
    case 'cherryPick': action = { kind, commits: order, ...(mainline ? { mainline: Number(mainline) } : {}) }; break;
    default: action = { kind }; break;
  }
  const merges = order.map(oid => commits.find(commit => commit.id === oid)).filter(commit => commit && commit.parents.length > 1);
  const reason = actionReason(action, state.session, operation) || (kind === 'switchBranch' && !state.refs.some(ref => ref.kind === 'local' && (ref.fullName === source || ref.name === source)) ? 'Choose an existing local branch.' : '') || (kind === 'cherryPick' && order.some(oid => !commits.some(commit => commit.id === oid)) ? 'Selected commit metadata is no longer loaded. Clear the sequence and select the commits again.' : '') || (kind === 'cherryPick' && merges.length && (!mainline || Number(mainline) > Math.min(...merges.map(commit => commit!.parents.length))) ? 'Select the mainline parent for merge commits.' : '');
  async function capture() {
    if (pendingRef.current || busy || reason) return;
    pendingRef.current = true;
    setPending(true); setError('');
    try {
      const request = await captureOperation(state.session.handle, action);
      if (live.current) setReview(request);
    } catch (e) { if (live.current) setError(errorMessage(e)); }
    finally { pendingRef.current = false; if (live.current) setPending(false); }
  }
  async function execute() {
    if (!review || pendingRef.current || busy) return;
    pendingRef.current = true;
    setPending(true); setError('');
    try { await onWrite('repository_run_operation', { request: review }); if (live.current) onClose(); }
    catch (e) { if (live.current) { setError(errorMessage(e)); setReview(null); } }
    finally { pendingRef.current = false; if (live.current) setPending(false); }
  }
  const current = state.session.headRef?.replace('refs/heads/', '') ?? 'detached HEAD';
  const prBranch = state.refs.find(ref => ref.fullName === context.ref && ref.kind === 'local');
  const prReason = prBranch ? '' : context.ref?.startsWith('refs/tags/') ? 'Tags cannot be pull-request source branches. Choose a local branch.' : context.ref?.startsWith('refs/remotes/') ? 'Pull requests require a local source branch. Create or check out a local branch from this remote-tracking ref first.' : 'Choose an existing local branch as the pull-request source.';
  return <dialog ref={dialog} className="dialog operation-dialog" aria-label="Git actions" onCancel={e => { if (pending) e.preventDefault(); else onClose(); }}>
    <h2>{review ? 'Review Git operation' : 'Git actions'}</h2><p>{review ? 'Reviewed target' : 'Current target'}: <strong>{review ? review.expectedHeadRef?.replace(/^refs\/heads\//, '') ?? 'detached HEAD' : current}</strong></p>
    {error && <p role="alert">{error}</p>}
    {review ? <><OperationSummary request={review} commits={commits} /><details><summary>Raw operation details</summary><pre className="operation-review">{JSON.stringify(review.action, null, 2)}</pre></details><p>Reviewed HEAD: <code>{review.expectedHead ?? 'unborn'}</code></p><p>Execution checks this captured HEAD, branch and operation fingerprint. Changes require a new review.</p><button disabled={pending || busy} onClick={() => setReview(null)}>Back</button><button className="primary-button" disabled={pending || busy} onClick={() => void execute()}>{pending ? 'Executing…' : 'Execute operation'}</button></> : <>
      <fieldset className="action-radio-group" disabled={pending} aria-label="Action">
        <legend>Action</legend>
        <div className="action-radio-options">
          <label><input type="radio" name="operation-action" value="merge" checked={kind === 'merge'} onChange={() => setKind('merge')} /> Merge source into {current}</label>
          <label><input type="radio" name="operation-action" value="rebase" checked={kind === 'rebase'} onChange={() => setKind('rebase')} /> Rebase {current} onto source</label>
          <label><input type="radio" name="operation-action" value="switchBranch" checked={kind === 'switchBranch'} onChange={() => setKind('switchBranch')} /> Switch branch</label>
          <label><input type="radio" name="operation-action" value="createBranch" checked={kind === 'createBranch'} onChange={() => setKind('createBranch')} /> Create branch</label>
          <label><input type="radio" name="operation-action" value="cherryPick" checked={kind === 'cherryPick'} onChange={() => setKind('cherryPick')} /> Cherry-pick commits</label>
          <label><input type="radio" name="operation-action" value="createTag" checked={kind === 'createTag'} onChange={() => setKind('createTag')} /> Create tag</label>
          {operation?.kind !== 'none' && <>
            <label><input type="radio" name="operation-action" value="continue" checked={kind === 'continue'} onChange={() => setKind('continue')} /> Continue operation</label>
            <label><input type="radio" name="operation-action" value="skip" checked={kind === 'skip'} onChange={() => setKind('skip')} /> Skip current commit</label>
            <label><input type="radio" name="operation-action" value="abort" checked={kind === 'abort'} onChange={() => setKind('abort')} /> Abort operation</label>
          </>}
        </div>
      </fieldset>
      {['merge', 'rebase', 'createBranch', 'switchBranch'].includes(kind) && <label>{kind === 'switchBranch' ? 'Local branch' : 'Source / starting revision'}<input list="operation-refs" value={source} onChange={e => setSource(e.target.value)} /><datalist id="operation-refs">{state.refs.filter(ref => kind !== 'switchBranch' || ref.kind === 'local').map(ref => <option key={ref.fullName} value={ref.fullName}>{ref.name}</option>)}</datalist></label>}
      {['createBranch', 'createTag'].includes(kind) && <label>Name<input autoFocus value={name} onChange={e => setName(e.target.value)} /></label>}
      {kind === 'createBranch' && <label><input type="checkbox" checked={checkout} onChange={e => setCheckout(e.target.checked)} /> Switch to new branch</label>}
      {kind === 'merge' && <label><input type="checkbox" checked={noFastForward} onChange={e => setNoFastForward(e.target.checked)} /> Always create a merge commit</label>}
      {kind === 'rebase' && <p>Replays the current branch onto the source and rewrites its commit IDs.</p>}
      {kind === 'abort' && <p>Abort the in-progress operation and discard its resolution progress.</p>}
      {kind === 'skip' && <p>Skip the current commit; its changes will not be included.</p>}
      {kind === 'createTag' && <label>Annotation (empty for lightweight tag)<textarea value={message} onChange={e => setMessage(e.target.value)} /></label>}
      {kind === 'cherryPick' && <><p>Application order (first to last). Use graph checkboxes to build a sequence.</p><ol>{order.map((oid, index) => <li key={oid}><code>{oid.slice(0, 12)}</code> {commits.find(commit => commit.id === oid)?.subject}<span className="operation-order"><button aria-label={`Move ${oid.slice(0, 7)} earlier`} disabled={!index} onClick={() => setOrder(moveCommit(order, index, -1))}>↑</button><button aria-label={`Move ${oid.slice(0, 7)} later`} disabled={index === order.length - 1} onClick={() => setOrder(moveCommit(order, index, 1))}>↓</button><button aria-label={`Remove ${oid.slice(0, 7)}`} onClick={() => setOrder(order.filter(value => value !== oid))}>×</button></span></li>)}</ol>{!!merges.length && <label>Mainline parent (applies to each merge in this sequence)<select value={mainline} onChange={e => setMainline(e.target.value)}><option value="">Choose explicitly…</option>{Array.from({ length: Math.min(...merges.map(commit => commit!.parents.length)) }, (_, index) => <option key={index} value={index + 1}>Parent {index + 1}: {merges.map(commit => commit!.parents[index].slice(0, 12)).join(', ')}</option>)}</select></label>}</>}
      {reason && <p role="status">{reason}</p>}<div className="operation-buttons"><button className="primary-button" disabled={pending || busy || !!reason} onClick={() => void capture()}>{pending ? 'Capturing state…' : 'Review operation'}</button><button disabled={!state.session.head || pending} onClick={() => onCompare(context.oid)}>Compare with current</button><button disabled={!prBranch || pending} aria-describedby={prReason ? 'pr-source-reason' : undefined} onClick={() => { if (prBranch && !pendingRef.current) onPullRequest(prBranch.fullName); }}>Create pull request…</button></div>
      {prReason && <p id="pr-source-reason">{prReason}</p>}
    </>}
    <button className="text-button" disabled={pending} onClick={onClose}>Cancel</button>
  </dialog>;
}

function revisionLabel(value: string): string {
  if (value.startsWith('refs/heads/')) return `Local branch ${value.slice('refs/heads/'.length)}`;
  if (value.startsWith('refs/remotes/')) return `Remote branch ${value.slice('refs/remotes/'.length)}`;
  if (value.startsWith('refs/tags/')) return `Tag ${value.slice('refs/tags/'.length)}`;
  return value;
}

function OperationSummary({ request, commits }: { request: OperationRequest; commits: CommitSummary[] }) {
  const { action } = request;
  const current = request.expectedHeadRef ? revisionLabel(request.expectedHeadRef) : 'Detached HEAD';
  const titles: Record<GitAction['kind'], string> = { merge: 'Merge branches', rebase: 'Rebase branch', cherryPick: 'Cherry-pick commits', createBranch: 'Create branch', switchBranch: 'Switch branch', createTag: 'Create tag', continue: 'Continue operation', skip: 'Skip current commit', abort: 'Abort operation' };
  return <section aria-label="Operation summary"><h3>{titles[action.kind]}</h3>
    {action.kind === 'merge' && <><p>Source: <strong>{revisionLabel(action.source)}</strong></p><p>Destination: <strong>{current}</strong></p><p>Fast-forward policy: {action.noFastForward ? 'Always create a merge commit (--no-ff).' : 'Allow fast-forward when possible; otherwise create a merge commit.'}</p></>}
    {action.kind === 'rebase' && <><p>Source branch to replay: <strong>{current}</strong></p><p>Destination (new base): <strong>{revisionLabel(action.onto)}</strong></p><p>Updates {current} with replayed commits. Their commit IDs change.</p></>}
    {action.kind === 'cherryPick' && <><p>Destination: <strong>{current}</strong></p><p>Source commits, applied in this order:</p><ol aria-label="Cherry-pick application order">{action.commits.map(oid => { const commit = commits.find(value => value.id === oid); return <li key={oid}><code>{oid}</code>{commit && ` — ${commit.subject}`}{commit && commit.parents.length > 1 && action.mainline && <span> · Mainline parent {action.mainline}: <code>{commit.parents[action.mainline - 1]}</code></span>}</li>; })}</ol></>}
    {action.kind === 'createBranch' && <><p>Source (starting revision): <strong>{revisionLabel(action.startPoint)}</strong></p><p>Destination: <strong>Local branch {action.name}</strong></p><p>{action.checkout ? 'Switch to the new branch after creating it.' : `Keep ${current} checked out.`}</p></>}
    {action.kind === 'switchBranch' && <><p>From: <strong>{current}</strong></p><p>Destination: <strong>{action.branch.startsWith('refs/') ? revisionLabel(action.branch) : `Local branch ${action.branch}`}</strong></p><p>Update the working tree to the selected branch.</p></>}
    {action.kind === 'createTag' && <><p>Source commit: <code>{action.oid}</code></p><p>Destination: <strong>Tag {action.name}</strong></p><p>Tag type: {action.message ? 'Annotated' : 'Lightweight'}</p>{action.message && <p>Annotation: {action.message}</p>}</>}
    {(['continue', 'skip', 'abort'] as string[]).includes(action.kind) && <><p>Operation branch: <strong>{current}</strong></p><p>{action.kind === 'continue' ? 'Resume the operation using the resolved, staged changes.' : action.kind === 'skip' ? 'Omit the current commit and continue with the remaining sequence.' : 'Stop the operation and discard its resolution progress.'}</p></>}
  </section>;
}
