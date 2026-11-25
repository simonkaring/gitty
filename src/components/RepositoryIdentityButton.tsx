import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage, native } from '../model/native';
import { formatGitIdentity, formatGitIdentitySources, type CommitIdentity, type GitIdentityValues, type RepositoryGitIdentity } from '../model/repository';
import { useSettings } from '../model/settings';
import { AuthorAvatar } from './AuthorAvatar';
import { Icons } from './icons';
import { RepositoryIdentityDialog } from './RepositoryIdentityDialog';
import { useDismiss } from './ui';

export function RepositoryIdentityButton({ handle, active, busy, revision, refresh, onApply }: {
  handle: string;
  active: boolean;
  busy: boolean;
  revision: number;
  refresh: number;
  onApply: (identity: CommitIdentity, expectedLocal: GitIdentityValues) => Promise<void>;
}) {
  const { settings } = useSettings();
  const [read, setRead] = useState<{ current: RepositoryGitIdentity; error?: never } | { current?: never; error: string } | null>(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const previewId = useId();
  const current = read?.current;
  const sources = current?.effectiveSources;
  const label = current?.effective.name?.trim() || current?.effective.email?.trim();
  const repository = !!sources && sources.name === 'repository' && sources.email === 'repository';

  useEffect(() => {
    if (!active) { setRead(null); setOpen(false); setPreview(false); return; }
    let live = true;
    native<RepositoryGitIdentity>('repository_git_identity', { handle })
      .then(current => { if (live) setRead({ current }); })
      .catch(error => { if (live) setRead({ error: errorMessage(error) }); });
    return () => { live = false; };
  }, [handle, active, revision, refresh, reload]);
  useDismiss(preview && !open && active, () => setPreview(false), [anchor]);

  return <>
    <div className="repository-identity" ref={anchor}
      onMouseEnter={() => { if (!open) setPreview(true); }}
      onMouseLeave={() => { if (!button.current?.matches(':focus-visible')) setPreview(false); }}>
      <button ref={button} type="button" className="icon-button repository-identity-trigger" aria-label="Git identity…"
        aria-describedby={previewId} aria-haspopup="dialog" disabled={busy || !active}
        onFocus={() => setPreview(true)} onBlur={() => { if (!anchor.current?.matches(':hover')) setPreview(false); }}
        onClick={() => { setRead(null); setReload(value => value + 1); setPreview(false); setOpen(true); }}>
        <span className="repository-identity-avatar" data-repository={repository && !!current?.effective.name?.trim() && !!current?.effective.email?.trim()} aria-hidden="true">
          {label ? <AuthorAvatar name={label} email={current?.effective.email ?? ''} mode={settings.authorAvatarMode} /> : '–'}
        </span>
        <Icons.UserRound size={16} />
      </button>
      <div id={previewId} className="menu repository-identity-preview" role="tooltip" hidden={!preview || open || !active}>
        <strong>Effective Git config</strong>
        {current ? <>
          <span>{label ? formatGitIdentity(current.effective) : 'No Git identity configured'}</span>
          {sources && (sources.name || sources.email) && <span className="muted">Source: {formatGitIdentitySources(sources)}</span>}
          {!repository && (current.local.name !== null || current.local.email !== null) &&
            <span className="muted">Repository config: {formatGitIdentity(current.local)}</span>}
        </> : <span>{read?.error ? 'Git identity unavailable' : 'Reading Git identity…'}</span>}
      </div>
    </div>
    {open && active && <RepositoryIdentityDialog current={current} readError={read?.error} onClose={() => setOpen(false)}
      onApply={async (identity, expectedLocal) => {
        try { await onApply(identity, expectedLocal); }
        finally { setRead(null); setReload(value => value + 1); }
      }} />}
  </>;
}
