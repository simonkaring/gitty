import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, FileCode2, GitCommitHorizontal, Minus, Plus } from 'lucide-react';
import type { DiffSpec, FileDiff, RepositoryMutation, RepositorySession, RepositoryStatus } from '../model/repository';
import { errorMessage, native, statusGroups, type WorkingGroup } from '../model/native';
import { clearSubmittedDraft, commitMessage, draftKey, operationPaths, readDraft, saveDraft, type CommitDraft, type MutationOutcome } from '../model/workflow';
import { useSettings } from '../model/settings';

const labels: Record<WorkingGroup, string> = { staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked', conflict: 'Conflicts' };
const descriptions: Record<WorkingGroup, string> = { staged: 'HEAD → index · included in your next commit', unstaged: 'Index → working tree · not yet staged', untracked: 'New files · not yet tracked by Git', conflict: 'Unresolved paths · open the conflict editor to resolve' };
const readDiff = (handle: string, spec: DiffSpec, path: string) => native<FileDiff>('repository_diff', { handle, spec, path });

export function WorkingChanges({ session, status, revision, busy, mutationBlocked = false, onMutation, onRefresh, onResolve, loadDiff = readDiff, demo = false }: {
  session: RepositorySession; status: RepositoryStatus | null; revision: number; busy: boolean;
  onMutation: (mutation: RepositoryMutation) => Promise<MutationOutcome>; onRefresh: () => Promise<void>;
  loadDiff?: typeof readDiff; demo?: boolean;
  onResolve?: (path: string) => void;
  mutationBlocked?: boolean;
}) {
  const key = draftKey(session);
  const [draft, setDraft] = useState(() => readDraft(key));
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
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const groups = statusGroups(status?.entries ?? []);
  const chosen = selection && groups[selection.group].some(entry => entry.path === selection.path) ? selection : null;
  const fallbackGroup = (['unstaged', 'untracked', 'staged', 'conflict'] as WorkingGroup[]).find(kind => groups[kind].length);
  const active = chosen ?? (fallbackGroup ? { group: fallbackGroup, path: groups[fallbackGroup][0].path } : null);
  const scope = JSON.stringify([session.handle, active?.group, active?.path, revision, retry, busy]);
  useEffect(() => {
    let live = true;
    setPreview(null);
    if (!active || busy) return;
    loadDiff(session.handle, { kind: active.group }, active.path).then(diff => { if (live) setPreview({ scope, diff }); }).catch(error => { if (live) setPreview({ scope, error: errorMessage(error) }); });
    return () => { live = false; };
  }, [scope, loadDiff]);
  const stagePaths = operationPaths(status?.entries ?? [], 'stage');
  const stagedPaths = operationPaths(status?.entries ?? [], 'unstage');
  const stagedCount = groups.staged.length;
  const unstagedCount = groups.unstaged.length + groups.untracked.length;
  const blocked = busy || mutationBlocked || !!operation || !status || session.bare || !!outcome?.refreshError;
  function edit(value: CommitDraft) { setDraft(value); setPersisted(saveDraft(key, value)); }
  async function perform(mutation: RepositoryMutation, fileCount = 1) {
    if (pending.current || blocked) return;
    pending.current = true;
    setOperation(mutation.kind === 'commit' ? 'Creating commit and refreshing repository…' : `${mutation.kind === 'stage' ? 'Staging' : 'Unstaging'} ${fileCount} file${fileCount === 1 ? '' : 's'} and refreshing…`);
    setOutcome(null); setSuccess('');
    try {
      const result = await onMutation(mutation);
      if (result.oid) {
        // Only a confirmed commit clears the submitted draft, never a failure.
        clearSubmittedDraft(key, draft);
      }
      if (!alive.current || result.superseded) return;
      setOutcome(result);
      if (result.oid) { setDraft({ subject: '', body: '' }); setSuccess(`Created commit ${result.oid.slice(0, 12)}.`); }
      else if (!result.error && !result.refreshError) setSuccess(mutation.kind === 'stage' ? 'Selected changes staged.' : 'Selected changes unstaged.');
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
        <p className="working-note">A partially staged file appears in both lists. Stage adds its remaining changes; unstage removes its indexed changes. All actions operate on whole files.</p>
      </div>
      <div className="working-review">
        <section className="working-preview" aria-label="Working file diff"><div className="review-heading"><div><strong>{active?.path ?? 'Your working tree is clean'}</strong><p>{active ? descriptions[active.group] : 'New changes will appear here.'}</p></div>{active && <button className="secondary-button" aria-pressed={split} onClick={() => setSplit(!split)}>{split ? 'Unified' : 'Side by side'}</button>}</div>
          {active && (!preview || preview.scope !== scope) && <p className="diff-placeholder" role="status">{busy ? 'Waiting for repository refresh…' : 'Loading diff…'}</p>}
          {preview?.scope === scope && preview.error && <p className="workflow-alert error" role="alert">{preview.error} <button onClick={() => setRetry(value => value + 1)}>Retry diff</button></p>}
          {preview?.scope === scope && preview.diff && <DiffPreview diff={preview.diff} split={split} />}
          {!active && <div className="clean-state"><Check size={32} /><h2>Nothing to review.</h2><p>Edit files in your repository, then return here to stage and commit.</p></div>}
        </section>
        <form className="commit-composer" aria-label="Commit composer" onSubmit={event => { event.preventDefault(); if (draft.subject.trim() && stagedCount && !groups.conflict.length) void perform({ kind: 'commit', message: commitMessage(draft) }); }}>
          <div className="composer-heading"><h2><GitCommitHorizontal size={20} />Create a commit</h2><span>{stagedCount} staged {stagedCount === 1 ? 'path' : 'paths'}</span></div>
          <label htmlFor="commit-subject">Summary <span>required</span></label><input id="commit-subject" name="subject" placeholder="Describe what changed" autoComplete="off" value={draft.subject} disabled={!!operation} onChange={event => edit({ ...draft, subject: event.target.value })} />
          <label htmlFor="commit-body">Description <span>optional</span></label><textarea id="commit-body" name="body" placeholder="Add context: why was this change needed?" rows={3} value={draft.body} disabled={!!operation} onChange={event => edit({ ...draft, body: event.target.value })} />
          <div className="composer-footer"><p>{persisted ? 'Draft saved for this repository.' : 'Storage unavailable. Draft is kept for this session only.'}<br />{!stagedCount ? 'Stage at least one file to commit.' : 'Only staged changes will be committed.'}</p><button className="primary-button" type="submit" disabled={blocked || !stagedCount || !draft.subject.trim() || !!groups.conflict.length}><GitCommitHorizontal size={18} />{operation.startsWith('Creating') ? 'Committing…' : 'Commit staged changes'}</button></div>
        </form>
      </div>
    </div>
  </section>;
}

export function DiffPreview({ diff, split }: { diff: FileDiff; split: boolean }) {
  return <><div className="diff-messages" role="status">{diff.binary && <p>Binary file · textual preview unavailable.</p>}{diff.truncated && <p>Diff truncated · only the available preview is shown.</p>}{diff.message && <p>{diff.message}</p>}{!diff.hunks.length && !diff.binary && <p>No textual hunks · metadata-only or empty file change.</p>}</div><div className={`native-diff ${split ? 'split' : ''}`} tabIndex={0} aria-label={`${split ? 'Side-by-side' : 'Unified'} diff for ${diff.path}`}>
    {diff.hunks.map((hunk, index) => <section key={index}><div className="hunk-header">{hunk.header}</div>{hunk.lines.map((line, i) => split && line.kind !== 'meta' ? <div className="split-row" key={i}><pre className={line.kind === 'remove' ? 'remove' : ''}>{line.kind !== 'add' ? `${line.oldLine ?? ''} ${line.content}` : ''}</pre><pre className={line.kind === 'add' ? 'add' : ''}>{line.kind !== 'remove' ? `${line.newLine ?? ''} ${line.content}` : ''}</pre></div> : <pre key={i} className={line.kind}><span className="line-number">{line.oldLine ?? ''}</span><span className="line-number">{line.newLine ?? ''}</span>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}{line.content}</pre>)}</section>)}
  </div></>;
}
