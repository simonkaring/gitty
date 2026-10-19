import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FolderGit2, LockKeyhole, Plus, RefreshCw } from 'lucide-react';
import type { RepositorySession } from '../model/repository';
import { errorMessage, isDemoHandle, native } from '../model/native';
import { worktreeEvents, worktreeLocation, worktreeName, type Worktree, type WorktreeAction, type WorktreeRequest, type WorktreeReview } from '../model/worktrees';
import { Dialog } from './ui';

const labels: Record<WorktreeAction, string> = { create: 'Create worktree', move: 'Move worktree', remove: 'Remove worktree', lock: 'Lock worktree', unlock: 'Unlock worktree', prune: 'Prune worktrees' };

export function Worktrees({ session, revision, active, busy, onOpen, onWrite }: {
  session: RepositorySession; revision: number; active: boolean; busy: boolean;
  onOpen: (location: RepositorySession['location']) => void;
  onWrite: (command: string, args: Record<string, unknown>) => Promise<void>;
}) {
  const [items, setItems] = useState<Worktree[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ action: WorktreeAction; target?: Worktree } | null>(null);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const id = ++sequence.current;
    try { const next = await native<Worktree[]>('repository_worktrees', { handle: session.handle }); if (id === sequence.current) { setItems(next); setError(''); } }
    catch (e) { if (id === sequence.current) setError(errorMessage(e)); }
  }, [session.handle]);
  useEffect(() => {
    if (!active) return;
    void reload();
    const refresh = () => { void reload(); };
    window.addEventListener('focus', refresh);
    worktreeEvents.addEventListener('change', refresh);
    return () => { sequence.current++; window.removeEventListener('focus', refresh); worktreeEvents.removeEventListener('change', refresh); };
  }, [active, revision, reload]);
  const demo = isDemoHandle(session.handle);
  return <section className="worktrees-section" aria-label="Worktrees">
    <div className="worktrees-heading"><FolderGit2 size={15} /><strong>Worktrees</strong><span className="count">{items.length}</span><span className="spacer" /><button className="icon-button sm" aria-label="Refresh worktrees" onClick={() => void reload()} disabled={busy}><RefreshCw size={13} /></button><button className="icon-button sm" aria-label="Create worktree" disabled={busy || demo} onClick={() => setEditing({ action: 'create' })}><Plus size={15} /></button></div>
    {items.map(item => <div className={`ref-action-row worktree-row${item.path === session.root ? ' current' : ''}`} key={item.path}>
      <button className="ref-item" title={item.path} aria-current={item.path === session.root ? 'true' : undefined} disabled={busy || item.bare || item.prunable !== null} onClick={() => onOpen(worktreeLocation(session.location, item.path))}>
        {item.path === session.root ? <Check size={14} /> : item.locked !== null ? <LockKeyhole size={14} /> : <FolderGit2 size={14} />}<span><span className="worktree-name">{worktreeName(item.path)}</span><small>{item.bare ? 'Bare repository' : item.branch?.replace('refs/heads/', '') ?? `Detached · ${item.head?.slice(0, 7) ?? 'unborn'}`}{item.prunable !== null ? ' · missing / stale' : ''}{item.locked !== null ? ' · locked' : ''}</small></span>
      </button>
      <button className="icon-button sm" aria-label={`Manage worktree ${item.path}`} disabled={busy || demo || item.main || item.bare} onClick={() => setEditing({ action: item.locked !== null ? 'unlock' : 'move', target: item })}>…</button>
    </div>)}
    {error && <p className="alert" role="alert">{error}</p>}
    {demo ? <p className="empty-category">Worktree management requires a real repository in the desktop app.</p> : <button className="text-button worktree-prune" disabled={busy} onClick={() => setEditing({ action: 'prune' })}>Prune stale worktrees…</button>}
    {editing && <WorktreeDialog key={`${session.handle}:${editing.target?.path ?? editing.action}`} session={session} initial={editing.action} target={editing.target} busy={busy} onWrite={onWrite} onClose={() => setEditing(null)} onComplete={(request, open) => {
      setEditing(null); worktreeEvents.dispatchEvent(new Event('change')); void reload();
      if (request.action === 'create' && open) onOpen(worktreeLocation(session.location, request.destination));
    }} />}
  </section>;
}

export function WorktreeDialog({ session, initial, target, busy, onWrite, onClose, onComplete }: {
  session: RepositorySession; initial: WorktreeAction; target?: Worktree; busy: boolean;
  onWrite: (command: string, args: Record<string, unknown>) => Promise<void>;
  onClose: () => void; onComplete: (request: WorktreeRequest, open: boolean) => void;
}) {
  const [request, setRequest] = useState<WorktreeRequest>({ action: initial, path: target?.path ?? '', destination: '', branch: '', startPoint: 'HEAD', reason: '', force: false });
  const [review, setReview] = useState<WorktreeReview | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [open, setOpen] = useState(true);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function update(patch: Partial<WorktreeRequest>) { setRequest(value => ({ ...value, ...patch })); setReview(null); setError(''); setAcknowledged(false); }
  const disabled = busy || pending;
  async function submit() {
    if (disabled || running.current) return;
    if (review && request.action === 'remove' && request.force && !acknowledged) return;
    running.current = true; setPending(true); setError('');
    try {
      if (!review) {
        const next = await native<WorktreeReview>('repository_worktree_review', { handle: session.handle, request });
        if (alive.current) setReview(next);
      } else {
        await onWrite('repository_worktree_execute', { request, token: review.token });
        if (alive.current) onComplete(request, open);
      }
    } catch (e) { if (alive.current) { setReview(null); setError(errorMessage(e)); } worktreeEvents.dispatchEvent(new Event('change')); }
    finally { running.current = false; if (alive.current) setPending(false); }
  }
  const destructive = request.action === 'remove' && request.force;
  return <Dialog title={labels[request.action]} onClose={() => { if (!disabled) onClose(); }} onSubmit={() => void submit()} footer={<><button type="button" className="secondary-button" disabled={disabled} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={disabled || (!!review && destructive && !acknowledged)}>{pending ? 'Working…' : !review ? 'Review' : destructive ? 'Force remove permanently' : labels[request.action]}</button></>}>
    {target && <><p className="worktree-path">{target.path}</p><label className="field">Action<select disabled={disabled} value={request.action} onChange={e => update({ action: e.target.value as WorktreeAction, force: false })}><option value="move">Move</option><option value="remove">Remove</option><option value={target.locked !== null ? 'unlock' : 'lock'}>{target.locked !== null ? 'Unlock' : 'Lock'}</option></select></label>{target.locked !== null && <p className="muted">Locked: {target.locked || 'No reason given'}. Unlock explicitly before moving or removing.</p>}</>}
    {(request.action === 'create' || request.action === 'move') && <label className="field">Destination folder (absolute path)<input required disabled={disabled} value={request.destination} placeholder={session.location.kind === 'wsl' ? '/home/me/project-feature' : 'Absolute destination path'} onChange={e => update({ destination: e.target.value })} /></label>}
    {request.action === 'create' && <><label className="field">New branch (optional)<input disabled={disabled} value={request.branch} placeholder="Leave blank to check out the starting branch" onChange={e => update({ branch: e.target.value })} /></label><label className="field">Starting branch or commit<input required disabled={disabled} value={request.startPoint} onChange={e => update({ startPoint: e.target.value })} /></label><label className="checkbox-field"><input type="checkbox" disabled={disabled} checked={open} onChange={e => setOpen(e.target.checked)} />Open in a tab after creating</label><p className="muted">An existing branch must not be checked out in another worktree. A commit creates a detached worktree.</p></>}
    {request.action === 'move' && <p className="muted">Close the target worktree’s tab first. Git preserves its files and branch; saved locations will be updated.</p>}
    {request.action === 'lock' && <label className="field">Lock reason (optional)<input disabled={disabled} value={request.reason} onChange={e => update({ reason: e.target.value })} /></label>}
    {request.action === 'remove' && <><p className="muted">Close the target worktree’s tab first. Removing deletes its folder, but does not delete its branch.</p><label className="checkbox-field"><input type="checkbox" disabled={disabled} checked={request.force} onChange={e => update({ force: e.target.checked })} />Force remove, including local changes</label>{destructive && <p className="alert" role="alert">Uncommitted, untracked, and ignored files may be permanently lost. This cannot be undone.</p>}</>}
    {request.action === 'prune' && <p className="muted">Remove stale Git worktree registrations using expiry “now”, including recently missing worktrees. Working folders and branches are not deleted. Locked registrations are retained. Review the exact preview before continuing.</p>}
    {review && <><p className="alert" data-tone="amber" role="status">Review captured. Changes to the worktree will require a new review.</p>{(review.preview || request.action === 'prune') && <pre className="worktree-preview">{review.preview || 'No stale registrations to prune.'}</pre>}{destructive && <label className="checkbox-field"><input type="checkbox" disabled={disabled} checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />I understand that local files and changes will be permanently deleted.</label>}</>}
    {error && <p className="alert" role="alert">{error}</p>}
  </Dialog>;
}
