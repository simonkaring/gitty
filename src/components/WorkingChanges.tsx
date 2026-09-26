import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Check, FileCode2, GitCommitHorizontal, Minus, Plus, RotateCw, X } from 'lucide-react';
import type { CommitDetail, DiffSpec, FileDiff, RepositoryMutation, RepositorySession, RepositoryStatus } from '../model/repository';
import { errorMessage, native, statusGroups, type WorkingGroup } from '../model/native';
import { clearSubmittedDraft, commitMessage, draftFromCommitMessage, draftKey, operationPaths, readDraft, saveDraft, type CommitDraft, type MutationOutcome } from '../model/workflow';
import { useSettings } from '../model/settings';

const labels: Record<WorkingGroup, string> = { staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked', conflict: 'Conflicts' };
const descriptions: Record<WorkingGroup, string> = { staged: 'HEAD → index · included in your next commit', unstaged: 'Index → working tree · not yet staged', untracked: 'New files · not yet tracked by Git', conflict: 'Unresolved paths · open the conflict editor to resolve' };
const readDiff = (handle: string, spec: DiffSpec, path: string) => native<FileDiff>('repository_diff', { handle, spec, path });

export interface ActiveDiffState {
  path: string;
  group?: WorkingGroup;
  diff: FileDiff | null;
  error?: string;
  loading: boolean;
  hunkAction?: 'stage_hunk' | 'unstage_hunk';
  busy?: boolean;
  unavailable?: string;
  onHunk?: (mutation: RepositoryMutation) => void;
  onToggleStage?: () => void;
  isStaged?: boolean;
}

export function WorkingChanges({ session, status, revision, busy, mutationBlocked = false, onMutation, onRefresh, onResolve, loadDiff = readDiff, demo = false, sidebarMode = false, activePath, onActiveDiffChange, onClose }: {
  session: RepositorySession; status: RepositoryStatus | null; revision: number; busy: boolean;
  onMutation: (mutation: RepositoryMutation) => Promise<MutationOutcome>; onRefresh: () => Promise<void>;
  loadDiff?: typeof readDiff; demo?: boolean;
  onResolve?: (path: string) => void;
  mutationBlocked?: boolean;
  sidebarMode?: boolean;
  activePath?: string | null;
  onActiveDiffChange?: (diff: ActiveDiffState | null) => void;
  onClose?: () => void;
}) {
  const key = draftKey(session);
  const composerId = useId();
  const [draft, setDraft] = useState(() => readDraft(key));
  const [amending, setAmending] = useState(false);
  const [amendDraft, setAmendDraft] = useState<CommitDraft | null>(null);
  const [amendHead, setAmendHead] = useState('');
  const [amendError, setAmendError] = useState('');
  const [persisted, setPersisted] = useState(true);
  const [selection, setSelection] = useState<{ group: WorkingGroup; path: string } | null>(null);
  const [preview, setPreview] = useState<{ scope: string; diff?: FileDiff; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [operation, setOperation] = useState('');
  const [outcome, setOutcome] = useState<MutationOutcome | null>(null);
  useEffect(() => { if (!mutationBlocked) setOutcome(value => value?.refreshError ? { ...value, refreshError: undefined } : value); }, [revision, mutationBlocked]);
  const [success, setSuccess] = useState('');
  const { settings } = useSettings();
  const [split, setSplit] = useState(settings.diffView === 'split');
  useEffect(() => setSplit(settings.diffView === 'split'), [settings.diffView]);
  const pending = useRef(false);
  const previousActivePath = useRef(activePath);
  const amendRequest = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const groups = statusGroups(status?.entries ?? []);
  const chosen = selection && groups[selection.group].some(entry => entry.path === selection.path) ? selection : null;
  const fallbackGroup = (['unstaged', 'untracked', 'staged', 'conflict'] as WorkingGroup[]).find(kind => groups[kind].length);
  const active = sidebarMode ? chosen : (chosen ?? (fallbackGroup ? { group: fallbackGroup, path: groups[fallbackGroup][0].path } : null));
  const scope = JSON.stringify([session.handle, active?.group, active?.path, revision, retry, busy]);
  const currentPreview = preview?.scope === scope ? preview : null;
  useEffect(() => {
    let live = true;
    setPreview(null);
    if (!active || busy) return;
    loadDiff(session.handle, { kind: active.group }, active.path).then(diff => { if (live) setPreview({ scope, diff }); }).catch(error => { if (live) setPreview({ scope, error: errorMessage(error) }); });
    return () => { live = false; };
  }, [scope, loadDiff]);

  useEffect(() => {
    if (sidebarMode && previousActivePath.current && activePath === null) {
      setSelection(null);
    }
    previousActivePath.current = activePath;
  }, [sidebarMode, activePath]);

  const stagePaths = operationPaths(status?.entries ?? [], 'stage');
  const stagedPaths = operationPaths(status?.entries ?? [], 'unstage');
  const stagedCount = groups.staged.length;
  const unstagedCount = groups.unstaged.length + groups.untracked.length;
  const blocked = busy || mutationBlocked || !!operation || !status || session.bare || !!outcome?.refreshError;

  useEffect(() => {
    if (!onActiveDiffChange) return;
    if (!active) {
      onActiveDiffChange(null);
      return;
    }
    const isStaged = active.group === 'staged';
    onActiveDiffChange({
      path: active.path,
      group: active.group,
      diff: currentPreview?.diff ?? null,
      error: currentPreview?.error,
      loading: !currentPreview,
      hunkAction: isStaged ? 'unstage_hunk' : active.group === 'unstaged' ? 'stage_hunk' : undefined,
      busy: blocked,
      unavailable: demo ? 'Hunk staging is unavailable in the demo. Open a desktop repository to stage individual hunks.' : undefined,
      onHunk: mutation => void perform(mutation),
      onToggleStage: () => {
        const operationKind = isStaged ? 'unstage' : 'stage';
        const entry = groups[active.group].find(e => e.path === active.path);
        if (entry) void perform({ kind: operationKind, paths: operationPaths([entry], operationKind) });
      },
      isStaged,
    });
  }, [active, currentPreview, busy, blocked, demo, onActiveDiffChange]);
  const composerDraft = amending ? amendDraft ?? { subject: '', body: '' } : draft;
  const amendReady = amending && !!amendDraft && !!session.head && amendHead === session.head && status?.head === session.head && status.headRef === session.headRef;
  function edit(value: CommitDraft) {
    if (amending) setAmendDraft(value);
    else { setDraft(value); setPersisted(saveDraft(key, value)); }
  }
  async function toggleAmend(enabled: boolean) {
    const token = ++amendRequest.current;
    setAmending(enabled); setAmendDraft(null); setAmendHead(''); setAmendError('');
    if (!enabled || demo || !session.head) return;
    try {
      const detail = await native<CommitDetail>('repository_commit', { handle: session.handle, oid: session.head });
      if (token !== amendRequest.current) return;
      setAmendDraft(draftFromCommitMessage(detail.body)); setAmendHead(session.head);
    } catch (error) { if (token === amendRequest.current) setAmendError(errorMessage(error)); }
  }
  useEffect(() => {
    if (amending && amendHead && amendHead !== session.head) {
      amendRequest.current++;
      setAmendDraft(null);
      setAmendError('HEAD changed after the amend message was loaded. Turn amend off and on to review the new last commit.');
    }
  }, [amending, amendHead, session.head]);
  async function perform(mutation: RepositoryMutation, fileCount = 1) {
    if (pending.current || blocked) return;
    pending.current = true;
    const hasLineIndices = 'lineIndices' in mutation && Array.isArray(mutation.lineIndices) && mutation.lineIndices.length > 0;
    setOperation(mutation.kind === 'commit' ? 'Creating commit and refreshing repository…' : mutation.kind === 'amend' ? 'Rewriting last commit and refreshing repository…' : `${mutation.kind === 'stage' || mutation.kind === 'stage_hunk' ? 'Staging' : 'Unstaging'} ${'hunkIndex' in mutation ? (hasLineIndices ? 'selected lines' : 'selected hunk') : `${fileCount} file${fileCount === 1 ? '' : 's'}`} and refreshing…`);
    setOutcome(null); setSuccess('');
    try {
      const result = await onMutation(mutation);
      if (result.oid && mutation.kind === 'commit') {
        // Only a confirmed commit clears the submitted draft, never a failure.
        clearSubmittedDraft(key, draft);
      }
      if (!alive.current || result.superseded) return;
      setOutcome(result);
      if (result.oid && mutation.kind === 'commit') { setDraft({ subject: '', body: '' }); setSuccess(`Created commit ${result.oid.slice(0, 12)}.`); }
      else if (result.oid && mutation.kind === 'amend') { amendRequest.current++; setAmending(false); setAmendDraft(null); setAmendHead(''); setSuccess(`Rewrote last commit as ${result.oid.slice(0, 12)}.`); }
      else if (!result.error && !result.refreshError) setSuccess(mutation.kind === 'stage' || mutation.kind === 'stage_hunk' ? (hasLineIndices ? 'Selected lines staged.' : 'Selected changes staged.') : (hasLineIndices ? 'Selected lines unstaged.' : 'Selected changes unstaged.'));
    } catch (error) {
      if (alive.current) setOutcome({ error: errorMessage(error), refreshError: 'Repository state could not be confirmed.' });
    } finally { pending.current = false; if (alive.current) setOperation(''); }
  }
  async function refresh() {
    if (pending.current || busy) return;
    pending.current = true; setOperation('Refreshing repository…');
    try { await onRefresh(); if (alive.current) setOutcome(value => value ? { ...value, refreshError: undefined } : null); }
    catch (error) { if (alive.current) setOutcome(value => ({ ...value, refreshError: errorMessage(error) })); }
    finally { pending.current = false; if (alive.current) setOperation(''); }
  }

  if (sidebarMode) {
    return <section className="working-inspector" aria-label="Working changes inspector" aria-busy={!!operation}>
      <div className="working-sidebar-header">
        <div>
          <span className="eyebrow">{demo ? 'DEMO WORKSPACE' : session.headRef?.replace('refs/heads/', '') ?? 'DETACHED HEAD'}</span>
          <h2>Working changes <span className="count">{status?.entries.length ?? 0}</span></h2>
        </div>
        <div className="working-sidebar-actions">
          <button className="icon-button" disabled={busy || !!operation} title="Refresh changes" aria-label="Refresh changes" onClick={() => void refresh()}>
            <RotateCw size={14} className={busy || !!operation ? 'spin' : ''} />
          </button>
          {onClose && <button className="icon-button" aria-label="Close working changes" title="Close" onClick={onClose}><X size={15} /></button>}
        </div>
      </div>
      {session.bare && <div className="workflow-alert" role="status">Bare repository.</div>}
      {!!groups.conflict.length && <div className="workflow-alert" role="status"><AlertTriangle size={15} />Unresolved conflicts.</div>}
      {outcome?.error && <div className="workflow-alert error" role="alert">{outcome.error}</div>}
      {outcome?.refreshError && <div className="workflow-alert error" role="alert">Refresh failed: {outcome.refreshError} <button onClick={() => void refresh()}>Retry</button></div>}
      {success && <div className="workflow-status" role="status"><Check size={14} />{success}</div>}
      <div className="working-sidebar-content">
        <div className="file-list-actions">
          <button className="secondary-button" disabled={blocked || !unstagedCount} onClick={() => void perform({ kind: 'stage', paths: stagePaths }, unstagedCount)}>
            <Plus size={13} />Stage all ({unstagedCount})
          </button>
          <button className="secondary-button" disabled={blocked || !stagedCount} onClick={() => void perform({ kind: 'unstage', paths: stagedPaths }, stagedCount)}>
            <Minus size={13} />Unstage all ({stagedCount})
          </button>
        </div>
        <div className="working-files-list">
          {(['conflict', 'unstaged', 'untracked', 'staged'] as WorkingGroup[]).map(kind => <section className={`working-category ${kind}`} key={kind} aria-label={`${labels[kind]} files`}>
            <h2>{labels[kind]}<span className="count">{groups[kind].length}</span></h2>
            {!groups[kind].length && <p className="empty-category">No {labels[kind].toLowerCase()} files</p>}
            {groups[kind].map(entry => {
              const partial = groups.staged.some(item => item.path === entry.path) && groups.unstaged.some(item => item.path === entry.path);
              const isSelected = active?.group === kind && active.path === entry.path;
              return <div className={`working-file ${isSelected ? 'selected' : ''}`} key={entry.path}>
                <button className="working-file-select" aria-pressed={isSelected} aria-label={`${labels[kind]}: ${entry.path}`} onClick={() => setSelection(current => current?.group === kind && current.path === entry.path ? null : { group: kind, path: entry.path })}>
                  <FileCode2 size={15} />
                  <span>
                    <strong>{entry.path}</strong>
                    {entry.oldPath && <small>{(entry.indexStatus === 'C' || (entry.indexStatus !== 'R' && entry.worktreeStatus === 'C')) ? 'Copied' : 'Renamed'} from {entry.oldPath}</small>}
                    {partial && <small>Partially staged</small>}
                  </span>
                </button>
                {kind === 'conflict' && onResolve && <button disabled={busy} onClick={() => onResolve(entry.path)}>Resolve…</button>}
                {kind !== 'conflict' && <button className="file-stage-button" disabled={blocked} title={partial ? kind === 'staged' ? 'Unstage all indexed changes for this path' : 'Stage the remaining working-tree changes for this path' : undefined} aria-label={`${kind === 'staged' ? 'Unstage' : 'Stage'} ${entry.path}`} onClick={() => { const operationKind = kind === 'staged' ? 'unstage' : 'stage'; void perform({ kind: operationKind, paths: operationPaths([entry], operationKind) }); }}>{kind === 'staged' ? <Minus size={16} /> : <Plus size={16} />}</button>}
              </div>;
            })}
          </section>)}
        </div>
        <form className="commit-composer" aria-label="Commit composer" onSubmit={event => { event.preventDefault(); if (!composerDraft.subject.trim() || groups.conflict.length) return; if (amending && amendReady && status && session.head) void perform({ kind: 'amend', message: commitMessage(composerDraft), expectedHead: session.head, expectedHeadRef: session.headRef, expectedStatusFingerprint: status.fingerprint }); else if (!amending && stagedCount) void perform({ kind: 'commit', message: commitMessage(composerDraft) }); }}>
          <div className="composer-heading"><h2><GitCommitHorizontal size={18} />{amending ? 'Rewrite last commit' : 'Create commit'}</h2><span>{stagedCount} staged</span></div>
          <label className="amend-control"><input type="checkbox" checked={amending} disabled={!!operation || demo || !session.head} onChange={event => void toggleAmend(event.target.checked)} /><span>Amend last commit</span></label>
          {amending && !amendDraft && !amendError && <p role="status">Loading last commit…</p>}
          {amendError && <p className="workflow-alert error" role="alert">{amendError}</p>}
          <label htmlFor={`${composerId}-subject`}>Summary <span>required</span></label>
          <input id={`${composerId}-subject`} name="subject" placeholder="Describe what changed" autoComplete="off" value={composerDraft.subject} disabled={!!operation || (amending && !amendDraft)} onChange={event => edit({ ...composerDraft, subject: event.target.value })} />
          <label htmlFor={`${composerId}-body`}>Description <span>optional</span></label>
          <textarea id={`${composerId}-body`} name="body" placeholder="Add context: why was this change needed?" rows={3} value={composerDraft.body} disabled={!!operation || (amending && !amendDraft)} onChange={event => edit({ ...composerDraft, body: event.target.value })} />
          <div className="composer-footer">
            <button className="primary-button" type="submit" disabled={blocked || (!amending && !stagedCount) || (amending && !amendReady) || !composerDraft.subject.trim() || !!groups.conflict.length}>
              <GitCommitHorizontal size={16} />{operation.startsWith('Rewriting') ? 'Amending…' : operation.startsWith('Creating') ? 'Committing…' : amending ? 'Rewrite last commit' : 'Commit staged changes'}
            </button>
          </div>
        </form>
      </div>
    </section>;
  }
  return <section className="working-workspace" aria-label="Working changes workspace" aria-busy={!!operation}>
    <header className="working-heading"><div><span className="eyebrow">{demo ? 'DEMO WORKSPACE' : session.headRef?.replace('refs/heads/', '') ?? 'UNBORN / DETACHED HEAD'}</span><h1>Working changes<span className="count">{status?.entries.length ?? 0}</span></h1><p>Review your changes. Shape your next commit.</p></div><button className="secondary-button" disabled={busy || !!operation} onClick={() => void refresh()}>Refresh changes</button></header>
    {session.bare && <div className="workflow-alert" role="status">This is a bare repository. A working tree is required to stage files and create commits.</div>}
    {!!groups.conflict.length && <div className="workflow-alert" role="status"><AlertTriangle size={18} />Unresolved conflicts. Resolve each path, then use Continue in the operation banner.{demo && ' Conflict editing requires a desktop repository.'}</div>}
    {outcome?.error && <div className="workflow-alert error" role="alert">{outcome.error} Your draft is preserved. Review refreshed status and history before trying again; a failed commit request may still have created a commit.</div>}
    {outcome?.refreshError && <div className="workflow-alert error" role="alert">Refresh failed: {outcome.refreshError} <button disabled={busy || !!operation} onClick={() => void refresh()}>Refresh repository state</button></div>}
    <div className="workflow-status" role="status" aria-live="polite">{operation || (success && <><Check size={16} />{success}</>) || `${stagedCount} staged · ${unstagedCount} unstaged or new paths`}</div>
    <div className="working-layout">
      <div className="working-files" aria-label="Working files">
        <div className="file-list-actions"><button className="secondary-button" disabled={blocked || !unstagedCount} onClick={() => void perform({ kind: 'stage', paths: stagePaths }, unstagedCount)}><Plus size={15} />Stage all</button><button className="secondary-button" disabled={blocked || !stagedCount} onClick={() => void perform({ kind: 'unstage', paths: stagedPaths }, stagedCount)}><Minus size={15} />Unstage all</button></div>
        {(['conflict', 'unstaged', 'untracked', 'staged'] as WorkingGroup[]).map(kind => <section className={`working-category ${kind}`} key={kind} aria-label={`${labels[kind]} files`}>
          <h2>{labels[kind]}<span className="count">{groups[kind].length}</span></h2>
          {!groups[kind].length && <p className="empty-category">No {labels[kind].toLowerCase()} files</p>}
          {groups[kind].map(entry => { const partial = groups.staged.some(item => item.path === entry.path) && groups.unstaged.some(item => item.path === entry.path); return <div className={`working-file ${active?.group === kind && active.path === entry.path ? 'selected' : ''}`} key={entry.path}>
            <button className="working-file-select" aria-pressed={active?.group === kind && active.path === entry.path} aria-label={`${labels[kind]}: ${entry.path}`} onClick={() => setSelection({ group: kind, path: entry.path })}><FileCode2 size={16} /><span><strong>{entry.path}</strong>{entry.oldPath && <small>{(entry.indexStatus === 'C' || (entry.indexStatus !== 'R' && entry.worktreeStatus === 'C')) ? 'Copied' : 'Renamed'} from {entry.oldPath}</small>}{partial && <small>Partially staged</small>}</span></button>
            {kind === 'conflict' && onResolve && <button disabled={busy} onClick={() => onResolve(entry.path)}>Resolve…</button>}
            {kind !== 'conflict' && <button className="file-stage-button" disabled={blocked} title={partial ? kind === 'staged' ? 'Unstage all indexed changes for this path' : 'Stage the remaining working-tree changes for this path' : undefined} aria-label={`${kind === 'staged' ? 'Unstage' : 'Stage'} ${entry.path}`} onClick={() => { const operationKind = kind === 'staged' ? 'unstage' : 'stage'; void perform({ kind: operationKind, paths: operationPaths([entry], operationKind) }); }}>{kind === 'staged' ? <Minus size={18} /> : <Plus size={18} />}</button>}
          </div>; })}
        </section>)}
        <p className="working-note">A partially staged file appears in both lists. File buttons act on whole files. Use the diff’s hunk buttons to stage or unstage a complete text hunk or selected lines.</p>
      </div>
      <div className="working-review">
        <section className="working-preview" aria-label="Working file diff"><div className="review-heading"><div><strong>{active?.path ?? 'Your working tree is clean'}</strong><p>{active ? descriptions[active.group] : 'New changes will appear here.'}</p></div>{active && <button className="secondary-button" aria-pressed={split} onClick={() => setSplit(!split)}>{split ? 'Unified' : 'Side by side'}</button>}</div>
          {active && (!preview || preview.scope !== scope) && <p className="diff-placeholder" role="status">{busy ? 'Waiting for repository refresh…' : 'Loading diff…'}</p>}
          {preview?.scope === scope && preview.error && <p className="workflow-alert error" role="alert">{preview.error} <button onClick={() => setRetry(value => value + 1)}>Retry diff</button></p>}
          {preview?.scope === scope && preview.diff && <DiffPreview diff={preview.diff} split={split} hunkAction={active?.group === 'staged' ? 'unstage_hunk' : active?.group === 'unstaged' ? 'stage_hunk' : undefined} busy={blocked} unavailable={demo ? 'Hunk staging is unavailable in the demo. Open a desktop repository to stage individual hunks.' : undefined} onHunk={mutation => void perform(mutation)} />}
          {!active && <div className="clean-state"><Check size={32} /><h2>Nothing to review.</h2><p>Edit files in your repository, then return here to stage and commit.</p></div>}
        </section>
        <form className="commit-composer" aria-label="Commit composer" onSubmit={event => { event.preventDefault(); if (!composerDraft.subject.trim() || groups.conflict.length) return; if (amending && amendReady && status && session.head) void perform({ kind: 'amend', message: commitMessage(composerDraft), expectedHead: session.head, expectedHeadRef: session.headRef, expectedStatusFingerprint: status.fingerprint }); else if (!amending && stagedCount) void perform({ kind: 'commit', message: commitMessage(composerDraft) }); }}>
          <div className="composer-heading"><h2><GitCommitHorizontal size={20} />{amending ? 'Rewrite last commit' : 'Create a commit'}</h2><span>{stagedCount} staged {stagedCount === 1 ? 'path' : 'paths'}</span></div>
          <label className="amend-control"><input type="checkbox" checked={amending} disabled={!!operation || demo || !session.head} onChange={event => void toggleAmend(event.target.checked)} /><span>Amend last commit</span></label>
          <p className="amend-description">{demo ? 'Amending history is available only for desktop repositories.' : amending ? 'This replaces the current HEAD commit. Staged changes will be included; with nothing staged, only its message is rewritten.' : 'Enable this to replace the current HEAD commit instead of creating a new one.'}</p>
          {amending && !amendDraft && !amendError && <p role="status">Loading the last commit message…</p>}
          {amendError && <p className="workflow-alert error" role="alert">{amendError}</p>}
          <label htmlFor={`${composerId}-subject`}>Summary <span>required</span></label><input id={`${composerId}-subject`} name="subject" placeholder="Describe what changed" autoComplete="off" value={composerDraft.subject} disabled={!!operation || (amending && !amendDraft)} onChange={event => edit({ ...composerDraft, subject: event.target.value })} />
          <label htmlFor={`${composerId}-body`}>Description <span>optional</span></label><textarea id={`${composerId}-body`} name="body" placeholder="Add context: why was this change needed?" rows={3} value={composerDraft.body} disabled={!!operation || (amending && !amendDraft)} onChange={event => edit({ ...composerDraft, body: event.target.value })} />
          <div className="composer-footer"><p>{amending ? 'Your ordinary commit draft is preserved while amending.' : persisted ? 'Draft saved for this repository.' : 'Storage unavailable. Draft is kept for this session only.'}<br />{amending ? stagedCount ? 'The staged changes and edited message will replace the last commit.' : 'No staged changes; only the last commit message will be rewritten.' : !stagedCount ? 'Stage at least one file to commit.' : 'Only staged changes will be committed.'}</p><button className="primary-button" type="submit" disabled={blocked || (!amending && !stagedCount) || (amending && !amendReady) || !composerDraft.subject.trim() || !!groups.conflict.length}><GitCommitHorizontal size={18} />{operation.startsWith('Rewriting') ? 'Amending…' : operation.startsWith('Creating') ? 'Committing…' : amending ? 'Rewrite last commit' : 'Commit staged changes'}</button></div>
        </form>
      </div>
    </div>
  </section>;
}

export function DiffPreview({
  diff,
  split,
  hunkAction,
  busy = false,
  unavailable,
  onHunk,
  selectedLines: controlledSelected,
  onToggleLine: controlledOnToggle,
}: {
  diff: FileDiff;
  split: boolean;
  hunkAction?: 'stage_hunk' | 'unstage_hunk';
  busy?: boolean;
  unavailable?: string;
  onHunk?: (mutation: RepositoryMutation) => void;
  selectedLines?: Record<number, number[]>;
  onToggleLine?: (hunkIndex: number, lineIndex: number) => void;
}) {
  const reason = hunkAction ? unavailable || (diff.truncated ? 'Hunk actions are unavailable for truncated previews. Use the whole-file buttons or Git.' : diff.binary ? 'Hunk actions are unavailable for binary files. Use the whole-file buttons.' : diff.hunkAction?.reason) || (!diff.hunkAction?.fingerprint ? 'Hunk actions are unavailable for this preview. Use the whole-file buttons or Git.' : undefined) : undefined;
  const fingerprint = !reason && diff.hunkAction?.fingerprint;

  const diffKey = `${diff.path}:${hunkAction ?? ''}:${fingerprint || ''}`;
  const [currentKey, setCurrentKey] = useState(diffKey);
  const [internalSelected, setInternalSelected] = useState<Record<number, number[]>>({});

  if (currentKey !== diffKey) {
    setCurrentKey(diffKey);
    setInternalSelected({});
  }

  const selected = controlledSelected ?? internalSelected;

  const toggleLine = (hunkIndex: number, lineIndex: number) => {
    if (busy || !fingerprint) return;
    if (controlledOnToggle) {
      controlledOnToggle(hunkIndex, lineIndex);
      return;
    }
    setInternalSelected(prev => {
      const current = prev[hunkIndex] ?? [];
      const next = current.includes(lineIndex)
        ? current.filter(i => i !== lineIndex)
        : [...current, lineIndex];
      return { ...prev, [hunkIndex]: next };
    });
  };

  const actionVerb = hunkAction === 'unstage_hunk' ? 'unstaging' : 'staging';

  return <><div className="diff-messages" role="status">{diff.binary && <p>Binary file · textual preview unavailable.</p>}{diff.truncated && <p>Diff truncated · only the available preview is shown.</p>}{diff.message && <p>{diff.message}</p>}{reason && <p className="hunk-unavailable">{reason}</p>}{!diff.hunks.length && !diff.binary && <p>No textual hunks · metadata-only or empty file change.</p>}</div><div className={`native-diff ${split ? 'split' : ''}`} tabIndex={0} aria-label={`${split ? 'Side-by-side' : 'Unified'} diff for ${diff.path}`}>
    {diff.hunks.map((hunk, index) => {
      const hunkSelected = selected[index] ?? [];
      const hasSelection = hunkSelected.length > 0;
      const buttonLabel = hasSelection
        ? hunkAction === 'unstage_hunk' ? 'Unstage selected lines' : 'Stage selected lines'
        : hunkAction === 'unstage_hunk' ? 'Unstage hunk' : 'Stage hunk';

      return <section key={index}>
        <div className="hunk-header hunk-action-header">
          <span>{hunk.header}</span>
          {hunkAction && (
            <button
              className="hunk-action-button"
              disabled={busy || !fingerprint || !onHunk}
              title={reason}
              aria-label={`${buttonLabel} ${index + 1} in ${diff.path}`}
              onClick={() => {
                if (!busy && fingerprint && onHunk) {
                  if (hasSelection) {
                    onHunk({
                      kind: hunkAction,
                      path: diff.path,
                      hunkIndex: index,
                      fingerprint,
                      lineIndices: [...hunkSelected].sort((a, b) => a - b),
                    });
                  } else {
                    onHunk({
                      kind: hunkAction,
                      path: diff.path,
                      hunkIndex: index,
                      fingerprint,
                    });
                  }
                }
              }}
            >
              {buttonLabel}
            </button>
          )}
        </div>
        {hunk.lines.map((line, i) => {
          const isSelectable = !!hunkAction && !reason && !!fingerprint && (line.kind === 'add' || line.kind === 'remove');
          const isSelected = isSelectable && hunkSelected.includes(i);
          const lineNum = line.kind === 'add' ? line.newLine : line.oldLine;

          return split && line.kind !== 'meta' ? (
            <div className={`split-row${isSelected ? ' selected-line' : ''}`} key={i}>
              <pre className={`${line.kind === 'remove' ? 'remove' : ''}${isSelected && line.kind === 'remove' ? ' selected-line' : ''}`}>
                {line.kind === 'remove' && isSelectable && (
                  <button
                    type="button"
                    className="line-select-toggle"
                    aria-pressed={isSelected}
                    disabled={busy}
                    title={`${isSelected ? 'Deselect' : 'Select'} line for ${actionVerb}`}
                    aria-label={`${isSelected ? 'Deselect' : 'Select'} line ${line.oldLine ?? ''} for ${actionVerb}`}
                    onClick={() => toggleLine(index, i)}
                  >
                    {isSelected && <Check size={10} strokeWidth={3} aria-hidden="true" />}
                  </button>
                )}
                {line.kind !== 'add' ? `${line.oldLine ?? ''} ${line.content}` : ''}
              </pre>
              <pre className={`${line.kind === 'add' ? 'add' : ''}${isSelected && line.kind === 'add' ? ' selected-line' : ''}`}>
                {line.kind === 'add' && isSelectable && (
                  <button
                    type="button"
                    className="line-select-toggle"
                    aria-pressed={isSelected}
                    disabled={busy}
                    title={`${isSelected ? 'Deselect' : 'Select'} line for ${actionVerb}`}
                    aria-label={`${isSelected ? 'Deselect' : 'Select'} line ${line.newLine ?? ''} for ${actionVerb}`}
                    onClick={() => toggleLine(index, i)}
                  >
                    {isSelected && <Check size={10} strokeWidth={3} aria-hidden="true" />}
                  </button>
                )}
                {line.kind !== 'remove' ? `${line.newLine ?? ''} ${line.content}` : ''}
              </pre>
            </div>
          ) : (
            <pre key={i} className={`${line.kind}${isSelected ? ' selected-line' : ''}`}>
              {isSelectable && (
                <button
                  type="button"
                  className="line-select-toggle"
                  aria-pressed={isSelected}
                  disabled={busy}
                  title={`${isSelected ? 'Deselect' : 'Select'} line for ${actionVerb}`}
                  aria-label={`${isSelected ? 'Deselect' : 'Select'} line ${lineNum ?? ''} for ${actionVerb}`}
                  onClick={() => toggleLine(index, i)}
                >
                  {isSelected && <Check size={10} strokeWidth={3} aria-hidden="true" />}
                </button>
              )}
              <span className="line-number">{line.oldLine ?? ''}</span>
              <span className="line-number">{line.newLine ?? ''}</span>
              {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
              {line.content}
            </pre>
          );
        })}
      </section>;
    })}
  </div></>;
}
