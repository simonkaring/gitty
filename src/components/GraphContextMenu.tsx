import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GitAction } from '../model/operations';
import type { RepositoryState } from '../model/repository';
import { DEFAULT_PULL_MODE, PULL_MODE_LABELS, type PullMode, type RemoteActionRequest } from '../model/remote';
import type { ActionContext } from './OperationDialog';
import { useDismiss } from './ui';

export interface MenuTarget { context: ActionContext; x: number; y: number; trigger: HTMLElement }

export function GraphContextMenu({ target, state, busy, onOperation, onShowDetails, onSetBase, onSetTarget, onCompare, onPullRequest, onRemoteAction, onPush, onCopy, onClose }: {
  target: MenuTarget; state: RepositoryState; busy: boolean;
  onOperation: (context: ActionContext) => void; onShowDetails: (oid: string) => void;
  onSetBase: (oid: string) => void; onSetTarget: (oid: string) => void; onCompare: (oid: string) => void;
  onPullRequest: (ref: string) => void; onRemoteAction: (action: RemoteActionRequest) => void; onPush: () => void;
  onCopy: (value: string, label: string) => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });
  useLayoutEffect(() => {
    const rect = menu.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(4, Math.min(target.x, window.innerWidth - rect.width - 4)), top: Math.max(4, Math.min(target.y, window.innerHeight - rect.height - 4)) });
    menu.current?.querySelector('button')?.focus();
  }, [target]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Tab') onClose();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && menu.current?.contains(document.activeElement)) {
        event.preventDefault();
        const items = [...menu.current.querySelectorAll<HTMLButtonElement>('button')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [onClose, target]);
  const trigger = useRef<HTMLElement | null>(target.trigger);
  trigger.current = target.trigger;
  useDismiss(true, onClose, [menu], trigger);
  const context = target.context;
  const ref = state.refs.find(value => value.fullName === context.ref);
  const current = context.ref === state.session.headRef;
  const tracking = ref?.kind === 'remote' ? [...state.remotes].sort((a, b) => b.length - a.length).find(remote => ref.fullName.startsWith(`refs/remotes/${remote}/`)) : undefined;
  function operation(kind: GitAction['kind']) { onOperation({ ...context, initial: kind }); }
  return <div ref={menu} className="graph-context-menu" role="menu" aria-label={ref ? `Actions for ${ref.name}` : 'Commit actions'} style={position}>
    <button role="menuitem" onClick={() => onShowDetails(context.oid)}>Show commit details</button>
    <div className="graph-menu-divider" role="separator" />
    {current && ref?.kind === 'local' && !!state.remotes.length && <>
      <button role="menuitem" disabled={busy} onClick={() => onRemoteAction({ kind: 'fetch' })}>Fetch</button>
      {(Object.keys(PULL_MODE_LABELS) as PullMode[]).map(mode => <button key={mode} role="menuitem" disabled={busy} onClick={() => onRemoteAction({ kind: 'pull', pullMode: mode })}>{PULL_MODE_LABELS[mode]}{mode === DEFAULT_PULL_MODE && ' (default)'}</button>)}
      <button role="menuitem" disabled={busy} onClick={onPush}>Push / Publish…</button>
      <div className="graph-menu-divider" role="separator" />
    </>}
    {tracking && <><button role="menuitem" disabled={busy} onClick={() => onRemoteAction({ kind: 'fetch', remote: tracking, branch: ref!.fullName.slice(`refs/remotes/${tracking}/`.length) })}>Fetch this remote branch</button><div className="graph-menu-divider" role="separator" /></>}
    {ref?.kind === 'local' && !current && <button role="menuitem" onClick={() => operation('switchBranch')}>Switch to {ref.name}…</button>}
    {!current && context.oid !== state.session.head && <><button role="menuitem" onClick={() => operation('merge')}>Merge into current…</button><button role="menuitem" onClick={() => operation('rebase')}>Rebase current onto this…</button><button role="menuitem" onClick={() => operation('cherryPick')}>Cherry-pick {ref ? 'tip commit' : 'commit'}…</button></>}
    <button role="menuitem" onClick={() => operation('createBranch')}>Create branch here…</button>
    <button role="menuitem" onClick={() => operation('createTag')}>Create tag here…</button>
    {ref?.kind === 'local' && <button role="menuitem" onClick={() => onPullRequest(ref.fullName)}>Create pull request…</button>}
    <div className="graph-menu-divider" role="separator" />
    {state.session.head && context.oid !== state.session.head && <button role="menuitem" onClick={() => onCompare(context.oid)}>Compare with current</button>}
    <button role="menuitem" onClick={() => onSetBase(context.oid)}>Set as comparison base</button>
    <button role="menuitem" onClick={() => onSetTarget(context.oid)}>Set as comparison target</button>
    <div className="graph-menu-divider" role="separator" />
    <button role="menuitem" onClick={() => onCopy(context.oid, 'Commit SHA')}>Copy commit SHA</button>
    {ref && <button role="menuitem" onClick={() => onCopy(ref.fullName, 'Reference name')}>Copy reference name</button>}
    <button role="menuitem" onClick={() => onOperation(context)}>More Git actions…</button>
  </div>;
}
