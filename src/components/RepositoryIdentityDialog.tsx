import { useState } from 'react';
import { errorMessage } from '../model/native';
import { formatGitIdentity, formatGitIdentitySources, type RepositoryGitIdentity } from '../model/repository';
import { useSettings } from '../model/settings';
import { Dialog } from './ui';

export function RepositoryIdentityDialog({ current, readError, onApply, onClose }: {
  current?: RepositoryGitIdentity;
  readError?: string;
  onApply: (identity: { name: string; email: string }, expectedLocal: RepositoryGitIdentity['local']) => Promise<void>;
  onClose: () => void;
}) {
  const { settings, githubCommitProfiles = [], openSettings } = useSettings();
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const profile = [...settings.commitProfiles, ...githubCommitProfiles].find(value => value.id === selected);
  async function apply() {
    if (!current || !profile || pending) return;
    setPending(true); setError(''); setSuccess('');
    try {
      await onApply({ name: profile.name, email: profile.email }, current.local);
      setSuccess('Repository-local Git identity updated.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setPending(false); }
  }
  const overridden = current && (['name', 'email'] as const).some(key => current.local[key] !== null && current.effectiveSources[key] !== 'repository');
  return <Dialog title="Repository Git identity" onClose={() => { if (!pending) onClose(); }} footer={<>
    <button className="text-button" type="button" disabled={pending} onClick={() => { onClose(); openSettings('Commit profiles'); }}>Manage profiles…</button>
    <span className="spacer" />
    <button className="secondary-button" type="button" disabled={pending} onClick={onClose}>Close</button>
    <button className="primary-button" type="button" disabled={!profile || !current || pending} onClick={() => void apply()}>{pending ? 'Applying…' : 'Apply to repository'}</button>
  </>}>
    <p className="muted">Set the name and email in this repository’s local Git config. Linked worktrees share these settings; your global Git config stays unchanged. Your separate “Commit as” selection still controls Gitty commits.</p>
    {current ? <dl className="detail-list">
      <dt>Repository config</dt><dd>{formatGitIdentity(current.local)}</dd>
      <dt>Effective here</dt><dd>{formatGitIdentity(current.effective)}</dd>
      <dt>Source</dt><dd>{formatGitIdentitySources(current.effectiveSources)}</dd>
    </dl> : !readError && <p className="muted" role="status">Reading Git identity…</p>}
    {overridden && <p className="alert" data-tone="amber" role="status">Another Git setting overrides the repository config here. Applying a profile may not change the effective identity in this worktree.</p>}
    <label className="field">Git profile<select value={profile?.id ?? ''} disabled={pending} onChange={event => { setSelected(event.target.value); setSuccess(''); }}><option value="">{settings.commitProfiles.length || githubCommitProfiles.length ? 'Choose a profile…' : 'No profiles available'}</option>{settings.commitProfiles.map(value => <option key={value.id} value={value.id}>{value.name} · {value.email}</option>)}{githubCommitProfiles.map(value => <option key={value.id} value={value.id}>GitHub: {value.name} · {value.email}</option>)}</select></label>
    {(error || readError) && <p className="alert" role="alert">{error || readError}</p>}{success && <p className="alert" data-tone="green" role="status">{success}</p>}
  </Dialog>;
}
