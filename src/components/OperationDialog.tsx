import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { Dialog } from './ui';
import { errorMessage } from '../model/native';
import type { GitAction, OperationRequest, OperationState, RebaseStep } from '../model/operations';
import type { CommitSummary, RepositoryState } from '../model/repository';
import { actionReason, moveCommit } from '../model/operationUi';
import { captureOperation } from '../model/operationFlow';

export interface ActionContext { oid: string; ref?: string; destination?: string; initial?: GitAction['kind']; commits?: string[] }
export type OperationWrite = (command: string, args: Record<string, unknown>) => Promise<void>;

/** Follow the checked-out branch rather than the interleaved graph row order. */
export function linearRebaseRange(head: string, base: string, commits: CommitSummary[]): CommitSummary[] | null {
  const byId = new Map(commits.map(commit => [commit.id, commit]));
  const range: CommitSummary[] = [];
  const seen = new Set<string>();
  let oid = head;
  while (oid !== base && range.length < 101) {
    if (seen.has(oid)) return null;
    seen.add(oid);
    const commit = byId.get(oid);
    if (!commit || commit.parents.length !== 1) return null;
    range.push(commit);
    oid = commit.parents[0];
  }
  return oid === base && range.length > 0 && range.length <= 100 ? range.reverse() : null;
}

export function OperationDialog({ state, operation, context, commits, busy, onWrite, onCompare, onPullRequest, onClose }: {
  state: RepositoryState; operation: OperationState | null; context: ActionContext; commits: CommitSummary[]; busy: boolean;
  onWrite: OperationWrite; onCompare: (source: string) => void; onPullRequest: (source: string) => void; onClose: () => void;
}) {
  const [kind, setKind] = useState<GitAction['kind']>(context.initial ?? (context.ref ? context.ref === state.session.headRef ? 'createBranch' : 'merge' : 'cherryPick'));
  const [source, setSource] = useState(context.ref ?? context.oid);
  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [noFastForward, setNoFastForward] = useState(false);
  const [message, setMessage] = useState('');
  const [order, setOrder] = useState(context.commits?.length ? context.commits : [context.oid].filter(Boolean));
  const [mainline, setMainline] = useState('');
  const [plan, setPlan] = useState<{ base: string; steps: RebaseStep[] } | null>(null);
  const [review, setReview] = useState<OperationRequest | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState('');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const baseId = state.refs.find(ref => ref.fullName === source || ref.name === source)?.commitId ?? source;
  const range = state.session.head ? linearRebaseRange(state.session.head, baseId, commits) : null;
  const steps: RebaseStep[] = plan?.base === baseId ? plan.steps : range?.map(commit => ({ oid: commit.id, instruction: 'pick' })) ?? [];
  function updateStep(index: number, change: Partial<RebaseStep>) {
    setPlan({ base: baseId, steps: steps.map((step, i) => i === index ? { ...step, ...change } : step) });
  }
  let action: GitAction;
  switch (kind) {
    case 'createBranch': action = { kind, name, startPoint: source, checkout }; break;
    case 'switchBranch': action = { kind, branch: source }; break;
    case 'merge': action = { kind, source, ...(context.destination ? { destination: context.destination } : {}), noFastForward }; break;
    case 'rebase': action = { kind, onto: source }; break;
    case 'interactiveRebase': action = { kind, onto: source, steps }; break;
    case 'createTag': action = { kind, name, oid: context.oid, ...(message ? { message } : {}) }; break;
    case 'cherryPick': action = { kind, commits: order, ...(mainline ? { mainline: Number(mainline) } : {}) }; break;
    default: action = { kind }; break;
  }
  const merges = order.map(oid => commits.find(commit => commit.id === oid)).filter(commit => commit && commit.parents.length > 1);
  const reason = actionReason(action, state.session, operation) || (kind === 'interactiveRebase' && state.session.location.kind === 'wsl' ? 'Interactive rebase requires a native repository.' : '') || (kind === 'interactiveRebase' && !range ? 'Choose a loaded ancestor within 100 linear commits; load older history if necessary.' : '') || (kind === 'interactiveRebase' && !steps.some(step => step.instruction !== 'drop') ? 'Retain at least one commit.' : '') || (kind === 'interactiveRebase' && steps.some((step, i) => ['squash', 'fixup'].includes(step.instruction) && !steps.slice(0, i).some(previous => previous.instruction !== 'drop')) ? 'A squash or fixup needs an earlier retained commit.' : '') || (kind === 'switchBranch' && !state.refs.some(ref => ref.kind === 'local' && (ref.fullName === source || ref.name === source)) ? 'Choose an existing local branch.' : '') || (kind === 'cherryPick' && order.some(oid => !commits.some(commit => commit.id === oid)) ? 'Selected commit metadata is no longer loaded. Clear the sequence and select the commits again.' : '') || (kind === 'cherryPick' && merges.length && (!mainline || Number(mainline) > Math.min(...merges.map(commit => commit!.parents.length))) ? 'Select the mainline parent for merge commits.' : '');
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
  const close = () => { if (!pending) onClose(); };
  const choice = (value: GitAction['kind'], label: ReactNode) => <label key={value} className="choice"><input type="radio" name="operation-action" value={value} checked={kind === value} onChange={() => setKind(value)} />{label}</label>;
  const footer = review ? <>
    <button className="secondary-button" disabled={pending || busy} onClick={() => setReview(null)}>Back</button>
    <span className="spacer" />
    <button className="secondary-button" disabled={pending} onClick={close}>Cancel</button>
    <button className="primary-button" disabled={pending || busy} onClick={() => void execute()}>{pending ? 'Executing…' : 'Execute operation'}</button>
  </> : <>
    <button className="secondary-button" disabled={!state.session.head || pending} onClick={() => onCompare(context.oid)}>Compare with current</button>
    <button className="secondary-button" disabled={!prBranch || pending} title={prReason || undefined} aria-describedby={prReason && context.ref ? 'pr-source-reason' : undefined} onClick={() => { if (prBranch && !pendingRef.current) onPullRequest(prBranch.fullName); }}>Create pull request…</button>
    <span className="spacer" />
    <button className="secondary-button" disabled={pending} onClick={close}>Cancel</button>
    <button className="primary-button" disabled={pending || busy || !!reason} onClick={() => void capture()}>{pending ? 'Capturing state…' : 'Review operation'}</button>
  </>;
  return <Dialog title={review ? 'Review Git operation' : 'Git actions'} size="lg" className="operation-dialog" onClose={close} footer={footer}>
    <p className="muted">{review ? 'Reviewed target' : 'Current target'} <span className="badge" data-tone="accent">{review ? review.expectedHeadRef?.replace(/^refs\/heads\//, '') ?? 'detached HEAD' : current}</span></p>
    {error && <p className="alert" role="alert">{error}</p>}
    {review ? <><OperationSummary request={review} commits={commits} /><details><summary>Raw operation details</summary><pre className="operation-review">{JSON.stringify(review.action, null, 2)}</pre></details><p className="muted">Reviewed HEAD <code>{review.expectedHead ?? 'unborn'}</code>. Execution checks this captured HEAD, branch and operation fingerprint; changes require a new review.</p></> : <>
      <fieldset className="choice-group" disabled={pending}>
        <legend className="section-label">Action</legend>
        {choice('merge', <>Merge source into {context.destination?.replace(/^refs\/heads\//, '') ?? current}</>)}{choice('rebase', <>Rebase {current} onto source</>)}{choice('interactiveRebase', 'Edit recent commits (interactive rebase)')}{choice('switchBranch', 'Switch branch')}{choice('createBranch', 'Create branch')}{choice('cherryPick', 'Cherry-pick commits')}{choice('createTag', 'Create tag')}
        {operation?.kind !== 'none' && <>{choice('continue', 'Continue operation')}{choice('skip', 'Skip current commit')}{choice('abort', 'Abort operation')}</>}
      </fieldset>
      {['merge', 'rebase', 'interactiveRebase', 'createBranch', 'switchBranch'].includes(kind) && <label className="field">{kind === 'switchBranch' ? 'Local branch' : kind === 'interactiveRebase' ? 'Base commit (ancestor of HEAD)' : 'Source / starting revision'}<input list="operation-refs" value={source} onChange={e => setSource(e.target.value)} /><datalist id="operation-refs">{state.refs.filter(ref => kind !== 'switchBranch' || ref.kind === 'local').map(ref => <option key={ref.fullName} value={ref.fullName}>{ref.name}</option>)}</datalist></label>}
      {['createBranch', 'createTag'].includes(kind) && <label className="field">Name<input autoFocus value={name} onChange={e => setName(e.target.value)} /></label>}
      {kind === 'createBranch' && <label className="check"><input type="checkbox" checked={checkout} onChange={e => setCheckout(e.target.checked)} /> Switch to new branch</label>}
      {kind === 'merge' && <label className="check"><input type="checkbox" checked={noFastForward} onChange={e => setNoFastForward(e.target.checked)} /> Always create a merge commit</label>}
      {kind === 'rebase' && <p className="muted">Replays the current branch onto the source and rewrites its commit IDs.</p>}
      {kind === 'interactiveRebase' && <><p className="muted">Reorder, drop, reword, squash, or fixup the commits since this base. Existing commit IDs will change; publish rewritten branches separately.</p><ol className="sequence" aria-label="Interactive rebase sequence">{steps.map((step, index) => <li key={step.oid}><code>{step.oid.slice(0, 12)}</code><span className="sequence-subject">{commits.find(commit => commit.id === step.oid)?.subject}</span><select aria-label={`Action for ${step.oid.slice(0, 12)}`} value={step.instruction} onChange={event => updateStep(index, { instruction: event.target.value as RebaseStep['instruction'] })}>{(['pick', 'drop', 'reword', 'squash', 'fixup'] as const).map(value => <option key={value} value={value}>{value}</option>)}</select><button type="button" className="icon-button sm" aria-label={`Move ${step.oid.slice(0, 7)} earlier`} disabled={!index} onClick={() => setPlan({ base: baseId, steps: moveCommit(steps, index, -1) })}><ArrowUp size={14} /></button><button type="button" className="icon-button sm" aria-label={`Move ${step.oid.slice(0, 7)} later`} disabled={index === steps.length - 1} onClick={() => setPlan({ base: baseId, steps: moveCommit(steps, index, 1) })}><ArrowDown size={14} /></button></li>)}</ol></>}
      {kind === 'abort' && <p className="muted">Abort the in-progress operation and discard its resolution progress.</p>}
      {kind === 'skip' && <p className="muted">Skip the current commit; its changes will not be included.</p>}
      {kind === 'createTag' && <label className="field">Annotation (empty for lightweight tag)<textarea value={message} onChange={e => setMessage(e.target.value)} /></label>}
      {kind === 'cherryPick' && <><p className="muted">Application order (first to last). Use graph checkboxes to build a sequence.</p><ol className="sequence">{order.map((oid, index) => <li key={oid}><code>{oid.slice(0, 12)}</code><span className="sequence-subject">{commits.find(commit => commit.id === oid)?.subject}</span><button className="icon-button sm" aria-label={`Move ${oid.slice(0, 7)} earlier`} disabled={!index} onClick={() => setOrder(moveCommit(order, index, -1))}><ArrowUp size={14} /></button><button className="icon-button sm" aria-label={`Move ${oid.slice(0, 7)} later`} disabled={index === order.length - 1} onClick={() => setOrder(moveCommit(order, index, 1))}><ArrowDown size={14} /></button><button className="icon-button sm" aria-label={`Remove ${oid.slice(0, 7)}`} onClick={() => setOrder(order.filter(value => value !== oid))}><X size={14} /></button></li>)}</ol>{!!merges.length && <label className="field">Mainline parent (applies to each merge in this sequence)<select value={mainline} onChange={e => setMainline(e.target.value)}><option value="">Choose explicitly…</option>{Array.from({ length: Math.min(...merges.map(commit => commit!.parents.length)) }, (_, index) => <option key={index} value={index + 1}>Parent {index + 1}: {merges.map(commit => commit!.parents[index].slice(0, 12)).join(', ')}</option>)}</select></label>}</>}
      {reason && <p className="alert" data-tone="amber" role="status">{reason}</p>}
      {prReason && context.ref && <p id="pr-source-reason" className="muted small">{prReason}</p>}
    </>}
  </Dialog>;
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
  const titles: Record<GitAction['kind'], string> = { merge: 'Merge branches', rebase: 'Rebase branch', interactiveRebase: 'Interactive rebase', cherryPick: 'Cherry-pick commits', createBranch: 'Create branch', switchBranch: 'Switch branch', createTag: 'Create tag', continue: 'Continue operation', skip: 'Skip current commit', abort: 'Abort operation' };
  return <section aria-label="Operation summary"><h3>{titles[action.kind]}</h3>
    {action.kind === 'merge' && <><p>Source: <strong>{revisionLabel(action.source)}</strong></p><p>Destination: <strong>{action.destination ? revisionLabel(action.destination) : current}</strong></p>{action.destination && action.destination !== request.expectedHeadRef && <p>Gitty will switch to the destination branch before merging.</p>}<p>Fast-forward policy: {action.noFastForward ? 'Always create a merge commit (--no-ff).' : 'Allow fast-forward when possible; otherwise create a merge commit.'}</p></>}
    {action.kind === 'rebase' && <><p>Source branch to replay: <strong>{current}</strong></p><p>Destination (new base): <strong>{revisionLabel(action.onto)}</strong></p><p>Updates {current} with replayed commits. Their commit IDs change.</p></>}
    {action.kind === 'interactiveRebase' && <><p>Rewriting <strong>{current}</strong> from base <code>{action.onto}</code>. Commit IDs will change; conflicts may require Continue or Abort.</p><ol aria-label="Reviewed rebase order">{action.steps.map(step => <li key={step.oid}><strong>{step.instruction}</strong> <code>{step.oid}</code> — {commits.find(commit => commit.id === step.oid)?.subject}</li>)}</ol></>}
    {action.kind === 'cherryPick' && <><p>Destination: <strong>{current}</strong></p><p>Source commits, applied in this order:</p><ol aria-label="Cherry-pick application order">{action.commits.map(oid => { const commit = commits.find(value => value.id === oid); return <li key={oid}><code>{oid}</code>{commit && ` — ${commit.subject}`}{commit && commit.parents.length > 1 && action.mainline && <span> · Mainline parent {action.mainline}: <code>{commit.parents[action.mainline - 1]}</code></span>}</li>; })}</ol></>}
    {action.kind === 'createBranch' && <><p>Source (starting revision): <strong>{revisionLabel(action.startPoint)}</strong></p><p>Destination: <strong>Local branch {action.name}</strong></p><p>{action.checkout ? 'Switch to the new branch after creating it.' : `Keep ${current} checked out.`}</p></>}
    {action.kind === 'switchBranch' && <><p>From: <strong>{current}</strong></p><p>Destination: <strong>{action.branch.startsWith('refs/') ? revisionLabel(action.branch) : `Local branch ${action.branch}`}</strong></p><p>Update the working tree to the selected branch.</p></>}
    {action.kind === 'createTag' && <><p>Source commit: <code>{action.oid}</code></p><p>Destination: <strong>Tag {action.name}</strong></p><p>Tag type: {action.message ? 'Annotated' : 'Lightweight'}</p>{action.message && <p>Annotation: {action.message}</p>}</>}
    {(['continue', 'skip', 'abort'] as string[]).includes(action.kind) && <><p>Operation branch: <strong>{current}</strong></p><p>{action.kind === 'continue' ? 'Resume the operation using the resolved, staged changes.' : action.kind === 'skip' ? 'Omit the current commit and continue with the remaining sequence.' : 'Stop the operation and discard its resolution progress.'}</p></>}
  </section>;
}
