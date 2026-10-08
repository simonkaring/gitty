import { useEffect, useState } from 'react';
import type { GitAction } from '../model/operations';
import { isDemoHandle, native } from '../model/native';
import type { RepositoryState } from '../model/repository';
import { DEFAULT_PULL_MODE, PULL_MODE_LABELS, type PullMode, type RemoteActionRequest } from '../model/remote';
import type { ActionContext } from './OperationDialog';
import { useContextMenu } from './useContextMenu';
import type { BranchDeleteScope } from '../model/branchDelete';

export interface MenuTarget { context: ActionContext; x: number; y: number; trigger: HTMLElement }

export function GraphContextMenu({ target, state, busy, onOperation, onSwitchBranch, onShowDetails, onSetBase, onSetTarget, onCompare, onPullRequest, onRemoteAction, onPush, onCopy, onDeleteBranch, onClose }: {
  target: MenuTarget; state: RepositoryState; busy: boolean;
  onOperation: (context: ActionContext) => void; onSwitchBranch: (ref: string) => void; onShowDetails: (oid: string) => void;
  onSetBase: (oid: string) => void; onSetTarget: (oid: string) => void; onCompare: (oid: string) => void;
  onPullRequest: (ref: string) => void; onRemoteAction: (action: RemoteActionRequest) => void; onPush: () => void;
  onCopy: (value: string, label: string) => void; onClose: () => void;
  onDeleteBranch: (fullName: string, scope: BranchDeleteScope) => void;
}) {
  const { menu, position } = useContextMenu(target, onClose);
  const [relation, setRelation] = useState<[number, number] | null>(null);
  useEffect(() => {
    setRelation(null);
    if (target.context.ref && state.session.headRef && target.context.ref !== state.session.headRef) {
      void native<[number, number]>('repository_branch_relation', { handle: state.session.handle, first: target.context.ref, second: state.session.headRef }).then(setRelation).catch(() => setRelation(null));
    }
  }, [target, state.session.handle, state.session.headRef]);
  const context = target.context;
  const ref = state.refs.find(value => value.fullName === context.ref);
  const current = context.ref === state.session.headRef;
  const hasOriginCounterpart = ref?.kind === 'local' && state.refs.some(value => value.fullName === `refs/remotes/origin/${ref.name}`);
  const hasLocalCounterpart = ref?.kind === 'remote' && state.refs.some(value => value.fullName === `refs/heads/${ref.fullName.slice('refs/remotes/origin/'.length)}`);
  const originRef = ref?.kind === 'local' ? `refs/remotes/origin/${ref.name}` : ref?.fullName;
  const localRef = ref?.kind === 'remote' ? `refs/heads/${ref.fullName.slice('refs/remotes/origin/'.length)}` : ref?.fullName;
  const demo = isDemoHandle(state.session.handle);
  const tracking = ref?.kind === 'remote' ? [...state.remotes].sort((a, b) => b.length - a.length).find(remote => ref.fullName.startsWith(`refs/remotes/${remote}/`)) : undefined;
  function operation(kind: GitAction['kind'], destination?: string, sourceRef?: string) { onOperation({ ...context, ...(destination ? { destination } : {}), ...(sourceRef ? { ref: sourceRef } : {}), initial: kind }); }
  return <div ref={menu} className="menu graph-context-menu" role="menu" aria-label={ref ? `Actions for ${ref.name}` : 'Commit actions'} style={position}>
    <button role="menuitem" onClick={() => onShowDetails(context.oid)}>Show commit details</button>
    <div className="menu-divider" role="separator" />
    {current && ref?.kind === 'local' && !!state.remotes.length && <>
      <button role="menuitem" disabled={busy} onClick={() => onRemoteAction({ kind: 'fetch' })}>Fetch</button>
      {(Object.keys(PULL_MODE_LABELS) as PullMode[]).map(mode => <button key={mode} role="menuitem" disabled={busy} onClick={() => onRemoteAction({ kind: 'pull', pullMode: mode })}>{PULL_MODE_LABELS[mode]}{mode === DEFAULT_PULL_MODE && ' (default)'}</button>)}
      <button role="menuitem" disabled={busy} onClick={onPush}>Push / Publish…</button>
      <div className="menu-divider" role="separator" />
    </>}
    {tracking && <><button role="menuitem" disabled={busy} onClick={() => onRemoteAction({ kind: 'fetch', remote: tracking, branch: ref!.fullName.slice(`refs/remotes/${tracking}/`.length) })}>Fetch this remote branch</button><div className="menu-divider" role="separator" /></>}
    {ref?.kind === 'local' && !current && <button role="menuitem" disabled={busy} onClick={() => onSwitchBranch(ref.fullName)}>Switch to {ref.name}</button>}
    {!current && (ref?.kind === 'local' || context.oid !== state.session.head) && <>{ref?.kind === 'local' && state.session.headRef && relation && <>{relation[0] > 0 ? <button role="menuitem" onClick={() => operation('merge', state.session.headRef!, ref.fullName)}>Merge {ref.name} into {state.session.headRef.replace(/^refs\/heads\//, '')}… · {relation[0]} commit{relation[0] === 1 ? '' : 's'} to bring in</button> : <button role="menuitem" disabled>{ref.name} already includes {state.session.headRef.replace(/^refs\/heads\//, '')}</button>}{relation[1] > 0 ? <button role="menuitem" onClick={() => operation('merge', ref.fullName, state.session.headRef!)}>Merge {state.session.headRef.replace(/^refs\/heads\//, '')} into {ref.name}… · {relation[1]} commit{relation[1] === 1 ? '' : 's'} to bring in</button> : <button role="menuitem" disabled>{state.session.headRef.replace(/^refs\/heads\//, '')} already includes {ref.name}</button>}</>}<button role="menuitem" onClick={() => operation('rebase')}>Rebase current onto this…</button><button role="menuitem" onClick={() => operation('cherryPick')}>Cherry-pick {ref ? 'tip commit' : 'commit'}…</button></>}
    <button role="menuitem" onClick={() => operation('createBranch')}>Create branch here…</button>
    <button role="menuitem" onClick={() => operation('createTag')}>Create tag here…</button>
    {ref?.kind === 'local' && <button role="menuitem" onClick={() => onPullRequest(ref.fullName)}>Create pull request…</button>}
    {ref?.kind === 'local' && <>
      <button role="menuitem" disabled={busy || demo || current} title={current ? 'Switch to another branch first.' : demo ? 'Branch deletion is unavailable in the demo.' : undefined} onClick={() => onDeleteBranch(localRef!, 'local')}>Delete local branch…{current ? ' (current branch)' : demo ? ' (unavailable in demo)' : ''}</button>
      {hasOriginCounterpart && <button role="menuitem" disabled={busy || demo} title={demo ? 'Branch deletion is unavailable in the demo.' : undefined} onClick={() => onDeleteBranch(originRef!, 'origin')}>Delete branch on origin…{demo ? ' (unavailable in demo)' : ''}</button>}
      {hasOriginCounterpart && <button role="menuitem" disabled={busy || demo || current} title={current ? 'Switch to another branch first.' : demo ? 'Branch deletion is unavailable in the demo.' : undefined} onClick={() => onDeleteBranch(localRef!, 'both')}>Delete local and origin branches…{current ? ' (current branch)' : demo ? ' (unavailable in demo)' : ''}</button>}
    </>}
    {ref?.kind === 'remote' && ref.fullName.startsWith('refs/remotes/origin/') && ref.fullName !== 'refs/remotes/origin/HEAD' && <>
      {hasLocalCounterpart && <button role="menuitem" disabled={busy || demo || state.session.headRef === localRef} title={state.session.headRef === localRef ? 'Switch to another branch first.' : demo ? 'Branch deletion is unavailable in the demo.' : undefined} onClick={() => onDeleteBranch(localRef!, 'local')}>Delete local branch…{state.session.headRef === localRef ? ' (current branch)' : ''}</button>}
      <button role="menuitem" disabled={busy || demo} title={demo ? 'Branch deletion is unavailable in the demo.' : undefined} onClick={() => onDeleteBranch(ref.fullName, 'origin')}>Delete branch on origin…</button>
      {hasLocalCounterpart && <button role="menuitem" disabled={busy || demo || state.session.headRef === localRef} title={state.session.headRef === localRef ? 'Switch to another branch first.' : demo ? 'Branch deletion is unavailable in the demo.' : undefined} onClick={() => onDeleteBranch(localRef!, 'both')}>Delete local and origin branches…{state.session.headRef === localRef ? ' (current branch)' : ''}</button>}
    </>}
    <div className="menu-divider" role="separator" />
    {state.session.head && context.oid !== state.session.head && <button role="menuitem" onClick={() => onCompare(context.oid)}>Compare with current</button>}
    <button role="menuitem" onClick={() => onSetBase(context.oid)}>Set as comparison base</button>
    <button role="menuitem" onClick={() => onSetTarget(context.oid)}>Set as comparison target</button>
    <div className="menu-divider" role="separator" />
    <button role="menuitem" onClick={() => onCopy(context.oid, 'Commit SHA')}>Copy commit SHA</button>
    {ref && <button role="menuitem" onClick={() => onCopy(ref.fullName, 'Reference name')}>Copy reference name</button>}
    <button role="menuitem" onClick={() => onOperation(context)}>More Git actions…</button>
  </div>;
}
