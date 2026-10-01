import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommitDetail, DiffFile, FileDiff, RepositorySession } from '../model/repository';
import { errorMessage, inspectorSpec, isDemoHandle, native } from '../model/native';
import { ArrowUpRight, Check, ChevronDown, Copy, FileCode2, GitCommitHorizontal, GitMerge, X } from 'lucide-react';
import type { ActiveDiffState } from './WorkingChanges';

function statusClass(status: string): string {
  const s = status.toUpperCase();
  if (s.startsWith('A')) return 'added';
  if (s.startsWith('D')) return 'deleted';
  return 'modified';
}

function statusLabel(status: string): string {
  return status[0]?.toUpperCase() ?? 'M';
}

export function NativeInspector({
  session,
  selected,
  revision,
  base,
  target,
  onJump,
  onBase,
  onTarget,
  onSwap,
  onClear,
  onClose,
  activePath,
  onActiveDiffChange,
  notify,
}: {
  session: RepositorySession;
  selected: string;
  revision: number;
  base: string;
  target: string;
  onJump: (id: string) => void;
  onBase: () => void;
  onTarget: () => void;
  onSwap: () => void;
  onClear: () => void;
  onClose: () => void;
  activePath: string | null;
  onActiveDiffChange: (diff: ActiveDiffState | null) => void;
  notify?: (message: string) => void;
}) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [parent, setParent] = useState('');
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [path, setPath] = useState('');
  const previousActivePath = useRef(activePath);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState('');
  const [diffError, setDiffError] = useState('');
  const [filesScope, setFilesScope] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setParent('');
    setDetail(null);
    setError('');
    setDiffError('');
    setDiffBusy(false);
    setCopied(false);
  }, [selected]);

  const validParent = detail?.id === selected && detail.parents.includes(parent) ? parent : undefined;
  const spec = useMemo(() => inspectorSpec(selected, 'unstaged', base, target, validParent), [base, target, selected, validParent]);
  const comparing = spec.kind === 'compare';
  const scope = JSON.stringify([selected, spec, revision, retry]);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    setDiffError('');
    setDiffBusy(false);
    setFiles([]);
    setFilesScope('');
    setDiff(null);
    Promise.all([
      selected ? native<CommitDetail>('repository_commit', { handle: session.handle, oid: selected }) : Promise.resolve(null),
      selected ? native<DiffFile[]>('repository_diff_files', { handle: session.handle, spec }) : Promise.resolve([]),
    ]).then(([commit, list]) => {
      if (live) {
        setDetail(commit);
        setFiles(list);
        setFilesScope(scope);
        setPath(old => (old && list.some(file => file.path === old) ? old : ''));
      }
    }).catch(e => {
      if (live) setError(errorMessage(e));
    }).finally(() => {
      if (live) setBusy(false);
    });
    return () => { live = false; };
  }, [session.handle, selected, spec, revision, retry, scope, onActiveDiffChange]);

  useEffect(() => {
    if (previousActivePath.current && activePath === null) setPath('');
    previousActivePath.current = activePath;
  }, [activePath]);

  useEffect(() => {
    if (!path) {
      onActiveDiffChange(null);
      return;
    }
    onActiveDiffChange({
      path,
      diff,
      loading: diffBusy,
      error: diffError,
    });
  }, [path, diff, diffBusy, diffError, onActiveDiffChange]);

  useEffect(() => {
    let live = true;
    setDiff(null);
    setDiffBusy(false);
    setDiffError('');
    if (!path || busy || filesScope !== scope || !files.some(file => file.path === path)) return;
    setDiffBusy(true);
    native<FileDiff>('repository_diff', { handle: session.handle, spec, path }).then(result => {
      if (live) setDiff(result);
    }).catch(e => {
      if (live) setDiffError(errorMessage(e));
    }).finally(() => {
      if (live) setDiffBusy(false);
    });
    return () => { live = false; };
  }, [session.handle, spec, path, files, busy, retry, scope, filesScope]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(selected);
      setCopied(true);
      notify?.('Full commit SHA copied');
    } catch {
      notify?.('Clipboard unavailable. Select and copy the SHA in commit details.');
    }
  }

  function selectFile(filePath: string) {
    setPath(current => current === filePath ? '' : filePath);
  }

  const additions = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const date = detail
    ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(detail.timestamp * 1000)
    : '';

  return (
    <aside className="inspector native-inspector" aria-label={comparing ? 'Commit comparison' : 'Commit inspector'}>
      <div className="inspector-content">
        {(error || diffError) && (
          <div className="workflow-alert error inspector-alert" role="alert">
            {error || diffError} <button className="secondary-button" onClick={() => setRetry(retry + 1)}>Retry inspection</button>
          </div>
        )}

        {selected && (
            <>
              <div className="commit-summary">
                <div className="commit-eyebrow">
                  <span>
                    {detail && detail.parents.length > 1 ? <GitMerge size={14} /> : <GitCommitHorizontal size={15} />}
                    {selected.slice(0, 7)}
                  </span>
                  {session.head && selected === session.head && <span className="badge" data-tone="accent">HEAD</span>}
                  <div className="commit-actions">
                    <button className="icon-button" aria-label="Copy full commit SHA" title="Copy full commit SHA" onClick={copy}>
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                    <button className="icon-button" aria-label="Close commit inspector" title="Close commit inspector" onClick={onClose}>
                      <X size={15} />
                    </button>
                  </div>
                </div>
                <h2>{detail?.subject || (busy ? 'Loading commit…' : selected)}</h2>
                {detail && (
                  <div className="author-block">
                    <span className={`avatar color-${detail.author ? detail.author.charCodeAt(0) % 5 : 0}`}>
                      {detail.author ? detail.author.split(' ').map(n => n[0]).join('').slice(0, 3) : ''}
                    </span>
                    <div>
                      <strong>{detail.author}</strong>
                      <span>{date} UTC</span>
                    </div>
                  </div>
                )}
              </div>

              {detail?.body && <p className="commit-description">{detail.body}</p>}

              <dl className="commit-metadata">
                <div>
                  <dt>Commit</dt>
                  <dd className="full-sha" title={selected}>
                    <code className="native-sha">{selected}</code>
                  </dd>
                </div>
                {detail && (
                  <div>
                    <dt>{detail.parents.length === 1 ? 'Parent' : 'Parents'}</dt>
                    <dd>
                      {detail.parents.length ? (
                        detail.parents.map(id => (
                          <button className="parent-link" key={id} onClick={() => onJump(id)}>
                            {id.slice(0, 7)}
                            <ArrowUpRight size={11} />
                          </button>
                        ))
                      ) : (
                        <span>Initial commit</span>
                      )}
                    </dd>
                  </div>
                )}
                {detail?.email && (
                  <div>
                    <dt>Author</dt>
                    <dd className="email">{detail.email}</dd>
                  </div>
                )}
              </dl>

              {!comparing && detail && detail.parents.length > 1 && (
                <div className="inspector-block">
                  <label>
                    Diff against parent:
                    <select value={validParent ?? detail.parents[0]} onChange={e => setParent(e.target.value)}>
                      {detail.parents.map((id, index) => (
                        <option key={id} value={id}>Parent {index + 1}: {id.slice(0, 7)}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              <div className="native-actions inspector-block">
                <button className="secondary-button" onClick={onBase}>Set as base</button>
                <button className="secondary-button" onClick={onTarget}>Set as target</button>
              </div>

              {(base || target) && (
                <div className="compare-summary">
                  <p>
                    Base: {base.slice(0, 7) || 'not selected'} → Target: {target.slice(0, 7) || 'not selected'}
                  </p>
                  <p>
                    {comparing
                      ? 'Changes that turn the base commit into the target commit. Removed lines belong to base; added lines belong to target.'
                      : 'Choose both commits to compare. Currently showing the selected commit’s changes.'}
                  </p>
                  <div className="native-actions">
                    <button className="secondary-button" disabled={!base || !target} onClick={onSwap}>Swap direction</button>
                    <button className="secondary-button" onClick={onClear}>Clear comparison</button>
                  </div>
                </div>
              )}
            </>
        )}

        <section className="changed-files" aria-label="Changed files">
          <div className="section-heading">
            <span><ChevronDown size={13} /> Changed files <span className="count">{files.length}</span></span>
            <span className="change-totals">
              {additions > 0 && <span className="added">+{additions}</span>}
              {deletions > 0 && <span className="removed">−{deletions}</span>}
            </span>
          </div>
          {files.map(f => {
            const isSelected = activePath ? f.path === activePath : f.path === path;
            const filename = f.path.split('/').at(-1);
            const dirname = f.path.split('/').slice(0, -1).join('/');
            return (
              <button
                key={f.path}
                className={`file-row ${isSelected ? 'active' : ''}`}
                onClick={() => selectFile(f.path)}
                title={isSelected ? `Close diff for ${f.path}` : `View diff for ${f.path}`}
                aria-pressed={isSelected}
              >
                <FileCode2 size={15} />
                <span className="file-name">
                  <strong>{filename}</strong>
                  <span>{dirname ? `${dirname}/` : ''}</span>
                </span>
                <span className={`file-status ${statusClass(f.status)}`}>{statusLabel(f.status)}</span>
              </button>
            );
          })}
        </section>

        {!busy && !files.length && (
          <p className="diff-placeholder">
            No changed files in this comparison.
          </p>
        )}

        <div className="inspector-tip">
          <FileCode2 size={17} />
          <p>{activePath ? <>Viewing <strong>{activePath.split('/').at(-1)}</strong> in the main pane.</> : 'Select a file above to inspect its diff in the main pane.'}</p>
        </div>
      </div>
      <div className="inspector-footer">
        <span className="live-dot" /> {isDemoHandle(session.handle) ? 'Demo repository' : 'Native repository'} <span>{session.location.kind === 'wsl' ? `WSL · ${session.location.distribution}` : 'Local'}</span>
      </div>
    </aside>
  );
}
