import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommitDetail, DiffFile, FileDiff, RepositorySession } from '../model/repository';
import { errorMessage, inspectorSpec, native } from '../model/native';
import { AlertTriangle, ArrowUpRight, Check, ChevronDown, Copy, FileCode2, FileMinus2, FilePenLine, FilePlus2, FileSymlink, GitCommitHorizontal, GitMerge, Pencil, X } from 'lucide-react';
import type { ActiveDiffState } from './WorkingChanges';
import { AuthorAvatar } from './AuthorAvatar';
import { formatCommitDate } from '../model/dates';
import type { AuthorAvatarMode } from '../model/settings';
import { commitMessage, draftFromCommitMessage, type MutationOutcome } from '../model/workflow';

/** Pause before fetching a newly selected commit, so rapid keyboard navigation only loads where it lands. */
export const SELECTION_DEBOUNCE_MS = 120;

function statusClass(status: string): string {
  const s = status.toUpperCase();
  if (s.startsWith('A')) return 'added';
  if (s.startsWith('D')) return 'deleted';
  return 'modified';
}

function statusLabel(status: string): string {
  return status[0]?.toUpperCase() ?? 'M';
}

function fileIcon(status: string) {
  const s = status.toUpperCase();
  return s.startsWith('A') ? FilePlus2 : s.startsWith('D') ? FileMinus2 : s.startsWith('R') ? FileSymlink : s.startsWith('C') ? FilePlus2 : s.startsWith('U') ? AlertTriangle : FilePenLine;
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
  onEditMessage,
  writeBlocked = false,
  authorAvatarMode = 'initials',
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
  /** Rewrites the message of the current HEAD only. The capture names the commit and branch the user
   * started editing; the owner revalidates them and never retargets. Never called for other commits. */
  onEditMessage?: (request: { oid: string; headRef: string; message: string }) => Promise<MutationOutcome>;
  /** A repository write is running, or the last refresh failed and writes are blocked. */
  writeBlocked?: boolean;
  authorAvatarMode?: AuthorAvatarMode;
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
  /** What the open editor is bound to. `original` is the normalized message the draft started from. */
  const [editor, setEditor] = useState<{ oid: string; headRef: string; original: string; token: number } | null>(null);
  const editorToken = useRef(0);
  const saving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; editorToken.current++; }; }, []);
  const isEditing = !!editor;
  const [subjectDraft, setSubjectDraft] = useState('');
  const [bodyDraft, setBodyDraft] = useState('');
  const [savingMessage, setSavingMessage] = useState(false);
  const [editError, setEditError] = useState('');

  useEffect(() => {
    setParent('');
    setError('');
    setDiffError('');
    setDiffBusy(false);
    setCopied(false);
    // Changing the selection ends the editor. A write already in flight still completes and is
    // reported by its own token check; it is never retargeted at the new selection.
    editorToken.current++;
    setEditor(null);
    setEditError('');
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
    setDiff(null);
    // The previous commit/files stay on screen (dimmed) until this fetch lands; every guard below
    // still compares against `selected`/`scope`, so stale data is never treated as current.
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
      if (live) {
        setError(errorMessage(e));
        setDetail(null);
        setFiles([]);
        setFilesScope('');
      }
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
      await navigator.clipboard.writeText(viewId);
      setCopied(true);
      notify?.('Full commit SHA copied');
    } catch {
      notify?.('Clipboard unavailable. Select and copy the SHA in commit details.');
    }
  }

  function selectFile(filePath: string) {
    setPath(current => current === filePath ? '' : filePath);
  }

  // Placeholders only when there is nothing to show yet (first load / after an error). On later
  // selections the previous snapshot stays put and is marked stale, so rows switch without a blank frame.
  const loading = !error && !!selected && !detail;
  const filesLoading = !error && !!selected && !filesScope;
  const stale = !error && !!detail && (detail.id !== selected || filesScope !== scope);
  const viewId = detail?.id ?? selected;
  const additions = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const date = detail
    ? formatCommitDate(detail.timestamp, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }, 'en')
    : '';

  const isHead = !!session.head && viewId === session.head && selected === session.head;
  // Editing is offered only for the current, loaded HEAD: a commit that is not HEAD, a detail still
  // being refetched, or one the backend refused is never editable, and eligibility is re-read on every revision.
  const loaded = !!detail && !stale && !error && detail.id === selected;
  const editable = loaded && isHead && !!session.headRef && detail.canEditMessage === true;
  const canStartEditing = editable && !writeBlocked && !savingMessage && !!onEditMessage;
  const editNote = loaded && isHead && !editable ? detail.editDisabledReason ?? null : null;
  const draftMessage = commitMessage({ subject: subjectDraft, body: bodyDraft });
  const draftChanged = !!editor && draftMessage !== editor.original;
  /** Why the open editor cannot be saved right now; its draft is kept either way. */
  const editBlock = (() => {
    if (!editor) return '';
    if (session.head !== editor.oid || session.headRef !== editor.headRef || selected !== editor.oid) return 'HEAD changed after editing started, so this draft can no longer be saved to that commit. Copy it, cancel, and edit the current commit.';
    if (!loaded) return 'Reloading commit details…';
    if (!editable) return detail?.editDisabledReason ?? 'This commit message can no longer be edited.';
    if (writeBlocked) return 'Another repository write is running, or a failed refresh is blocking writes.';
    return '';
  })();
  const canSave = !!editor && !editBlock && !savingMessage && !!subjectDraft.trim() && draftChanged;

  function startEditing() {
    if (!canStartEditing || !detail || !session.headRef) return;
    const message = detail.body || detail.subject;
    const draft = draftFromCommitMessage(message);
    setSubjectDraft(draft.subject);
    setBodyDraft(draft.body);
    setEditError('');
    setEditor({ oid: detail.id, headRef: session.headRef, original: commitMessage(draftFromCommitMessage(message)), token: ++editorToken.current });
  }

  function cancelEditing() {
    if (saving.current) return;
    editorToken.current++;
    setEditor(null);
    setEditError('');
  }

  async function handleSaveMessage() {
    // Every guard reads current props, not what was true when the editor opened.
    if (!editor || saving.current || !onEditMessage) return;
    if (editBlock) return; // already shown as the editor's alert
    if (!subjectDraft.trim()) { setEditError('Commit subject cannot be empty.'); return; }
    if (!draftChanged) { setEditError('The message has not changed.'); return; }
    const { token, oid, headRef } = editor;
    saving.current = true;
    setSavingMessage(true);
    setEditError('');
    let outcome: MutationOutcome;
    try {
      outcome = await onEditMessage({ oid, headRef, message: draftMessage });
    } catch (e) {
      outcome = { error: errorMessage(e) };
    } finally {
      saving.current = false;
      if (mounted.current) setSavingMessage(false);
    }
    if (!mounted.current) return;
    const live = editorToken.current === token;
    const written = !!outcome.oid && !outcome.error;
    const refreshFailed = outcome.refreshError ? ` Refreshing the repository failed: ${outcome.refreshError}. Writes stay blocked until a refresh succeeds.` : '';
    let message = '';
    if (written) message = outcome.refreshError ? `Commit message updated.${refreshFailed}` : 'Commit message updated.';
    else if (outcome.superseded) message = 'The repository session changed while the message was being saved. Refresh and check the last commit before trying again.';
    else if (outcome.error) message = `${outcome.error}${refreshFailed} Your draft is kept; nothing is retried automatically.`;
    else message = 'Git did not report a new commit. Refresh and check the last commit before trying again.';
    if (written) {
      if (live) { editorToken.current++; setEditor(null); }
      notify?.(message);
    } else if (live) {
      setEditError(message);
    } else {
      // The editor was closed or moved on, but the write was attempted: say what happened.
      notify?.(`Commit message was not updated. ${message}`);
    }
  }

  return (
    <aside className="inspector native-inspector" aria-label={comparing ? 'Commit comparison' : 'Commit inspector'} aria-busy={loading || filesLoading || stale}>
      <div className="inspector-content" data-stale={stale || undefined}>
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
                    {viewId.slice(0, 7)}
                  </span>
                  {!!session.head && viewId === session.head && <span className="badge" data-tone="accent">HEAD</span>}
                  <div className="commit-actions">
                    {canStartEditing && !isEditing && (
                      <button
                        className="icon-button"
                        aria-label="Edit commit message"
                        title="Edit commit message"
                        onClick={startEditing}
                      >
                        <Pencil size={14} />
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

                {isEditing ? (
                  <form
                    className="commit-message-editor"
                    onSubmit={e => {
                      e.preventDefault();
                      void handleSaveMessage();
                    }}
                  >
                    {(editError || editBlock) && (
                      <div className="workflow-alert error" role="alert">
                        {editError || editBlock}
                      </div>
                    )}
                    <label>
                      Subject
                      <input
                        type="text"
                        autoFocus
                        value={subjectDraft}
                        disabled={savingMessage}
                        onChange={e => setSubjectDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelEditing();
                          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            void handleSaveMessage();
                          }
                        }}
                      />
                    </label>
                    <label>
                      Description
                      <textarea
                        rows={4}
                        value={bodyDraft}
                        disabled={savingMessage}
                        placeholder="Optional extended description…"
                        onChange={e => setBodyDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelEditing();
                          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            void handleSaveMessage();
                          }
                        }}
                      />
                    </label>
                    <div className="commit-message-editor-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={savingMessage}
                        onClick={cancelEditing}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="primary-button"
                        disabled={!canSave}
                      >
                        {savingMessage ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    {loading ? (
                      <h2 className="skeleton-text" style={{ width: '65%' }}>Loading commit…</h2>
                    ) : (
                      <h2
                        className={canStartEditing ? 'editable-commit-heading' : undefined}
                        onClick={canStartEditing ? startEditing : undefined}
                        title={canStartEditing ? 'Click to edit commit message' : undefined}
                        tabIndex={canStartEditing ? 0 : undefined}
                        role={canStartEditing ? 'button' : undefined}
                        onKeyDown={canStartEditing ? e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            startEditing();
                          }
                        } : undefined}
                      >
                        {detail?.subject || viewId}
                      </h2>
                    )}
                    {loading && (
                      <div className="author-block" aria-hidden="true">
                        <span className="avatar skeleton-text" />
                        <div>
                          <strong className="skeleton-text" style={{ width: '60%' }}>Author name</strong>
                          <span className="skeleton-text">Jan 1, 2025, 12:00 PM UTC</span>
                        </div>
                      </div>
                    )}
                    {detail && (
                      <div className="author-block">
                        <AuthorAvatar name={detail.author} email={detail.email} mode={authorAvatarMode} />
                        <div>
                          <strong>{detail.author}</strong>
                          <span>{date} UTC</span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {!isEditing && editNote && <p className="commit-edit-note" role="note">{editNote}</p>}

              {!isEditing && detail?.body && (
                <p
                  className={`commit-description${canStartEditing ? ' editable-commit-body' : ''}`}
                  onClick={canStartEditing ? startEditing : undefined}
                  title={canStartEditing ? 'Click to edit commit message' : undefined}
                  tabIndex={canStartEditing ? 0 : undefined}
                  role={canStartEditing ? 'button' : undefined}
                  onKeyDown={canStartEditing ? e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      startEditing();
                    }
                  } : undefined}
                >
                  {detail.body}
                </p>
              )}

              <dl className="commit-metadata">
                <div>
                  <dt>Commit</dt>
                  <dd className="full-sha" title={viewId}>
                    <code className="native-sha">{viewId}</code>
                  </dd>
                </div>
                {loading && (
                  <>
                    <div aria-hidden="true"><dt>Parent</dt><dd><span className="skeleton-text" style={{ fontSize: 'var(--fs-xs)' }}>0000000</span></dd></div>
                    <div aria-hidden="true"><dt>Author</dt><dd><span className="skeleton-text">author@example.com</span></dd></div>
                  </>
                )}
                {detail && (
                  <div>
                    <dt>{detail.parents.length === 1 ? 'Parent' : 'Parents'}</dt>
                    <dd>
                      {detail.parents.length ? (
                        detail.parents.map(id => (
                          <button className="parent-link" key={id} disabled={stale} onClick={() => onJump(id)}>
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
                    <select disabled={stale} value={validParent ?? detail.parents[0]} onChange={e => setParent(e.target.value)}>
                      {detail.parents.map((id, index) => (
                        <option key={id} value={id}>Parent {index + 1}: {id.slice(0, 7)}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              <div className="button-row inspector-block">
                <button className="secondary-button compact" onClick={onBase}>Set as compare base</button>
                <button className="secondary-button compact" onClick={onTarget}>Set as compare target</button>
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
                  <div className="button-row">
                    <button className="secondary-button compact" disabled={!base || !target} onClick={onSwap}>Swap direction</button>
                    <button className="secondary-button compact" onClick={onClear}>Clear comparison</button>
                  </div>
                </div>
              )}
            </>
        )}

        <section className="changed-files" aria-label="Changed files">
          <div className="section-heading">
            <span><ChevronDown size={13} /> Changed files {!filesLoading && <span className="count">{files.length}</span>}</span>
            <span className="change-totals">
              {additions > 0 && <span className="added">+{additions}</span>}
              {deletions > 0 && <span className="removed">−{deletions}</span>}
            </span>
          </div>
          {filesLoading && [18, 26, 12, 22].map((n, i) => (
            <div className="file-row" key={i} aria-hidden="true">
              <span className="skeleton" style={{ width: 15, height: 15, flexShrink: 0 }} />
              <span className="file-name">
                <strong className="skeleton-text">{'x'.repeat(n)}</strong>
                <span className="skeleton-text">{'x'.repeat(n + 8)}</span>
              </span>
              <span className="file-status skeleton-text" />
            </div>
          ))}
          {files.map(f => {
            const isSelected = activePath ? f.path === activePath : f.path === path;
            const filename = f.path.split('/').at(-1);
            const dirname = f.path.split('/').slice(0, -1).join('/');
            const Icon = fileIcon(f.status);
            const iconStatus = f.status.toUpperCase().startsWith('A') ? 'added' : f.status.toUpperCase().startsWith('D') ? 'deleted' : f.status.toUpperCase().startsWith('R') ? 'renamed' : f.status.toUpperCase().startsWith('U') ? 'conflict' : 'modified';
            return (
              <button
                key={f.path}
                className={`file-row ${isSelected ? 'active' : ''}`}
                onClick={() => selectFile(f.path)}
                title={isSelected ? `Close diff for ${f.path}` : `View diff for ${f.path}`}
                aria-pressed={isSelected}
              >
                <Icon size={15} data-status={iconStatus} aria-label={`${iconStatus} file`} />
                <span className="file-name">
                  <strong>{filename}</strong>
                  <span>{dirname ? `${dirname}/` : ''}</span>
                </span>
                <span className={`file-status ${statusClass(f.status)}`}>{statusLabel(f.status)}</span>
              </button>
            );
          })}
        </section>

        {!filesLoading && !files.length && (
          <p className="diff-placeholder">
            No changed files in this comparison.
          </p>
        )}

        <div className="inspector-tip">
          <FileCode2 size={17} />
          <p>{activePath ? <>Viewing <strong>{activePath.split('/').at(-1)}</strong> in the main pane.</> : 'Select a file above to inspect its diff in the main pane.'}</p>
        </div>
      </div>
    </aside>
  );
}
