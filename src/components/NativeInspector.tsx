import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommitDetail, DiffFile, FileDiff, RepositorySession, RepositoryStatus } from '../model/repository';
import { errorMessage, inspectorSpec, native, statusGroups, WORKING_ID, type WorkingGroup } from '../model/native';
import { ArrowUpRight, Check, ChevronDown, Copy, FileCode2, GitCommitHorizontal, GitMerge, X } from 'lucide-react';
import { DiffPreview, type ActiveDiffState } from './WorkingChanges';
import { useSettings } from '../model/settings';

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
  status,
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
  status: RepositoryStatus | null;
  revision: number;
  base: string;
  target: string;
  onJump: (id: string) => void;
  onBase: () => void;
  onTarget: () => void;
  onSwap: () => void;
  onClear: () => void;
  onClose: () => void;
  activePath?: string | null;
  onActiveDiffChange?: (diff: ActiveDiffState | null) => void;
  notify?: (message: string) => void;
}) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [parent, setParent] = useState('');
  const [group, setGroup] = useState<WorkingGroup>('unstaged');
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
  const { settings } = useSettings();
  const [split, setSplit] = useState(settings.diffView === 'split');
  useEffect(() => setSplit(settings.diffView === 'split'), [settings.diffView]);
  const [expanded, setExpanded] = useState(false);
  const working = selected === WORKING_ID;
  const groups = statusGroups(status?.entries ?? []);

  useEffect(() => {
    setParent('');
    setDetail(null);
    setError('');
    setDiffError('');
    setDiffBusy(false);
    setCopied(false);
  }, [selected]);

  const validParent = detail?.id === selected && detail.parents.includes(parent) ? parent : undefined;
  const spec = useMemo(() => inspectorSpec(selected, group, base, target, validParent), [base, target, group, selected, validParent]);
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
      !working && selected ? native<CommitDetail>('repository_commit', { handle: session.handle, oid: selected }) : Promise.resolve(null),
      selected ? native<DiffFile[]>('repository_diff_files', { handle: session.handle, spec }) : Promise.resolve([]),
    ]).then(([commit, list]) => {
      if (live) {
        setDetail(commit);
        setFiles(list);
        setFilesScope(scope);
        setPath(old => (old && list.some(file => file.path === old) ? old : onActiveDiffChange ? '' : list[0]?.path ?? ''));
      }
    }).catch(e => {
      if (live) setError(errorMessage(e));
    }).finally(() => {
      if (live) setBusy(false);
    });
    return () => { live = false; };
  }, [session.handle, selected, working, spec, revision, retry, scope, onActiveDiffChange]);

  useEffect(() => {
    if (previousActivePath.current && activePath === null) setPath('');
    previousActivePath.current = activePath;
  }, [activePath]);

  useEffect(() => {
    if (!onActiveDiffChange) return;
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
    <aside className={`inspector native-inspector ${expanded ? 'expanded' : ''}`} aria-label={working ? 'Working changes' : comparing ? 'Commit comparison' : 'Commit inspector'}>
      <div className="inspector-content">
        {(error || diffError) && (
          <div className="workflow-alert error" style={{ margin: '16px 24px' }} role="alert">
            {error || diffError} <button className="secondary-button" style={{ marginLeft: 8 }} onClick={() => setRetry(retry + 1)}>Retry inspection</button>
          </div>
        )}

        {working ? (
          <div className="commit-summary">
            <div className="commit-eyebrow">
              <strong>Working changes</strong>
              <div className="commit-actions">
                <button className="icon-button" aria-label="Close commit inspector" title="Close commit inspector" onClick={onClose}><X size={15} /></button>
              </div>
            </div>
            <p style={{ margin: '16px 0 12px', fontSize: '14px', color: 'var(--secondary)' }}>
              {group === 'staged' ? 'Staged: changes from HEAD to the index (staging area).' : group === 'unstaged' ? 'Unstaged: changes from the index to the working tree.' : group === 'untracked' ? 'Untracked: files in the working tree that are not in the index.' : 'Conflicts: unresolved paths in the index and working tree.'}
            </p>
            {base && target && <p style={{ fontSize: '13px', color: 'var(--muted)' }}>Saved commit comparison is paused while viewing working changes.</p>}
            <div className="working-groups" aria-label="Working change categories" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '14px 0' }}>
              {(Object.keys(groups) as WorkingGroup[]).map(kind => (
                <button key={kind} aria-pressed={group === kind} onClick={() => setGroup(kind)}>
                  {kind} ({groups[kind].length})
                </button>
              ))}
            </div>
          </div>
        ) : (
          selected && (
            <>
              <div className="commit-summary">
                <div className="commit-eyebrow">
                  <span>
                    {detail && detail.parents.length > 1 ? <GitMerge size={14} /> : <GitCommitHorizontal size={15} />}
                    {selected.slice(0, 7)}
                  </span>
                  {session.head && selected === session.head && <span className="head-label">HEAD</span>}
                  <div className="commit-actions">
                    {!onActiveDiffChange && (
                      <button className="secondary-button" onClick={() => setExpanded(!expanded)} aria-pressed={expanded} style={{ fontSize: '12px', minHeight: '28px', padding: '2px 8px' }}>
                        {expanded ? 'Reduce width' : 'Expand diff'}
                      </button>
                    )}
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
                <div style={{ margin: '0 24px 16px' }}>
                  <label style={{ fontSize: '13px', color: 'var(--secondary)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    Diff against parent:
                    <select value={validParent ?? detail.parents[0]} onChange={e => setParent(e.target.value)}>
                      {detail.parents.map((id, index) => (
                        <option key={id} value={id}>Parent {index + 1}: {id.slice(0, 7)}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              <div className="native-actions" style={{ padding: '0 24px', margin: '0 0 16px', display: 'flex', gap: '8px' }}>
                <button className="secondary-button" onClick={onBase}>Set as base</button>
                <button className="secondary-button" onClick={onTarget}>Set as target</button>
              </div>

              {(base || target) && (
                <div className="compare-summary" style={{ margin: '0 24px 20px' }}>
                  <p style={{ margin: '0 0 6px', fontWeight: 550, color: 'var(--text)' }}>
                    Base: {base.slice(0, 7) || 'not selected'} → Target: {target.slice(0, 7) || 'not selected'}
                  </p>
                  <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--secondary)' }}>
                    {comparing
                      ? 'Changes that turn the base commit into the target commit. Removed lines belong to base; added lines belong to target.'
                      : 'Choose both commits to compare. Currently showing the selected commit’s changes.'}
                  </p>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="secondary-button" disabled={!base || !target} onClick={onSwap}>Swap direction</button>
                    <button className="secondary-button" onClick={onClear}>Clear comparison</button>
                  </div>
                </div>
              )}
            </>
          )
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
          <p className="diff-placeholder" style={{ padding: '20px 24px', margin: 0, color: 'var(--muted)', fontSize: '13px' }}>
            No changed files in this comparison.
          </p>
        )}

        {onActiveDiffChange ? (
          activePath ? (
            <div className="inspector-tip">
              <FileCode2 size={17} />
              <p>Viewing <strong>{activePath.split('/').at(-1)}</strong> in the main pane.</p>
            </div>
          ) : (
            <div className="inspector-tip">
              <FileCode2 size={17} />
              <p>Select a file above to inspect its diff in the main pane.</p>
            </div>
          )
        ) : (
          <>
            {path && filesScope === scope && (
              <div className="diff-section" aria-label={`Diff for ${path}`} style={{ padding: '0 24px 20px' }}>
                <div className="diff-heading">
                  <span>{path.split('/').at(-1)}</span>
                  <button aria-pressed={split} onClick={() => setSplit(!split)}>
                    {split ? 'Unified' : 'Side by side'}
                  </button>
                </div>
                {diffBusy && <p className="diff-placeholder" role="status">Loading diff…</p>}
                {diff && <DiffPreview diff={diff} split={split} />}
              </div>
            )}
            {!path && (
              <div className="inspector-tip">
                <FileCode2 size={17} />
                <p>Select a file to inspect its changes.</p>
              </div>
            )}
          </>
        )}
      </div>
      <div className="inspector-footer">
        <span className="live-dot" /> Native repository <span>{session.location.kind === 'wsl' ? `WSL · ${session.location.distribution}` : 'Local'}</span>
      </div>
    </aside>
  );
}
