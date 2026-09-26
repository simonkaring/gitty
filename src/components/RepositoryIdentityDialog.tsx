import { useEffect, useRef, useState } from 'react';
import { native, errorMessage } from '../model/native';
import type { RepositoryGitIdentity } from '../model/repository';
import { useSettings } from '../model/settings';

export function RepositoryIdentityDialog({ handle, revision, onApply, onClose }: {
  handle: string;
  revision: number;
  onApply: (identity: { name: string; email: string }, expectedLocal: RepositoryGitIdentity['local']) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const { settings, openSettings } = useSettings();
  const [current, setCurrent] = useState<RepositoryGitIdentity | null>(null);
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function reload() {
    try { const value = await native<RepositoryGitIdentity>('repository_git_identity', { handle }); if (alive.current) { setCurrent(value); setError(''); } }
    catch (e) { if (alive.current) setError(errorMessage(e)); }
  }
  useEffect(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; }; }, []);
  useEffect(() => { void reload(); }, [handle, revision]);
  const profile = settings.commitProfiles.find(value => value.id === selected);
  async function apply() {
    if (!current || !profile || pending) return;
    setPending(true); setError(''); setSuccess('');
    try {
      await onApply({ name: profile.name, email: profile.email }, current.local);
      if (alive.current) { await reload(); setSuccess('Repository-local Git identity updated. Check the effective identity for overrides.'); }
    } catch (e) { if (alive.current) { setError(errorMessage(e)); await reloadAfterFailure(); } }
    finally { if (alive.current) setPending(false); }
  }
  async function reloadAfterFailure() {
    try { const value = await native<RepositoryGitIdentity>('repository_git_identity', { handle }); if (alive.current) setCurrent(value); }
    catch { /* Keep the original write error visible. */ }
  }
  const format = (value: RepositoryGitIdentity['local']) => `${value.name ?? 'Name not set'} · ${value.email ?? 'Email not set'}`;
  const overridden = current && (current.local.name !== current.effective.name || current.local.email !== current.effective.email);
  return <dialog ref={dialog} className="dialog operation-dialog publish-dialog" aria-label="Repository Git identity" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <h2>Repository Git identity</h2>
    <p>Set the name and email in this repository’s local Git config. Linked worktrees share these settings; your global Git config stays unchanged. Your separate “Commit as” selection still controls Gitty commits.</p>
    {current ? <><p>Repository config: <strong>{format(current.local)}</strong></p><p>Effective here: <strong>{format(current.effective)}</strong></p>{overridden && <p role="status">Another Git setting overrides the repository config here. Applying a profile may not change the effective identity in this worktree.</p>}</> : <p role="status">Reading Git identity…</p>}
    <label>Saved profile<select value={selected} disabled={pending} onChange={event => { setSelected(event.target.value); setSuccess(''); }}><option value="">Choose a profile…</option>{settings.commitProfiles.map(value => <option key={value.id} value={value.id}>{value.name} · {value.email}</option>)}</select></label>
    {!settings.commitProfiles.length && <p>No saved profiles yet.</p>}
    <button className="text-button" type="button" disabled={pending} onClick={() => { onClose(); openSettings('Commit profiles'); }}>Manage profiles…</button>
    {error && <p role="alert">{error}</p>}{success && <p role="status">{success}</p>}
    <button className="primary-button" type="button" disabled={!profile || !current || pending} onClick={() => void apply()}>{pending ? 'Applying…' : 'Apply to repository'}</button>
    <button type="button" disabled={pending} onClick={onClose}>Close</button>
  </dialog>;
}
