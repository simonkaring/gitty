import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, FileCode2, FileMinus2, FilePenLine, FilePlus2, FileSymlink, GitCommitHorizontal, Minus, Plus, RotateCw, Undo2, User, X } from 'lucide-react';
import type { CommitDetail, DiffSpec, FileDiff, RepositoryMutation, RepositorySession, RepositoryStatus, StatusEntry } from '../model/repository';
import { errorMessage, isDemoHandle, native, statusGroups, type WorkingGroup } from '../model/native';
import { clearSubmittedDraft, commitMessage, discardableEntries, draftFromCommitMessage, draftKey, operationPaths, readDraft, saveDraft, type CommitDraft, type MutationOutcome } from '../model/workflow';
import { useSettings } from '../model/settings';
import { commitProfileRepositoryKey } from '../model/commitProfiles';
import { DiscardDialog } from './DiscardDialog';
import { FileContextMenu, type FileMenuTarget } from './FileContextMenu';

const labels: Record<WorkingGroup, string> = { staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked', conflict: 'Conflicts' };
const readDiff = (handle: string, spec: DiffSpec, path: string) => native<FileDiff>('repository_diff', { handle, spec, path });

/** The three groups the working-changes list renders. Untracked files are listed under `unstaged`. */
export type WorkingSection = 'conflict' | 'unstaged' | 'staged';
const SECTIONS: readonly WorkingSection[] = ['conflict', 'unstaged', 'staged'];

/** Presentation-only disclosure state: which groups are folded and whether the commit composer
 * and its identity drawer are open. It never touches drafts, selection, or any Git state, and it is
 * deliberately not persisted; the repository pane owns it per repository session. */
export interface WorkingDisclosure {
  collapsed: Record<WorkingSection, boolean>;
  composerCollapsed: boolean;
  identityOpen: boolean;
}
export const DEFAULT_WORKING_DISCLOSURE: WorkingDisclosure = { collapsed: { conflict: false, unstaged: false, staged: false }, composerCollapsed: false, identityOpen: false };
export type WorkingDisclosureUpdate = (current: WorkingDisclosure) => WorkingDisclosure;

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

export function WorkingChanges({ session, status, revision, busy, mutationBlocked = false, onMutation, onRefresh, onResolve, loadDiff = readDiff, activePath, onActiveDiffChange, onClose, disclosure, onDisclosureChange }: {
  session: RepositorySession; status: RepositoryStatus | null; revision: number; busy: boolean;
  onMutation: (mutation: RepositoryMutation) => Promise<MutationOutcome>; onRefresh: () => Promise<void>;
  loadDiff?: typeof readDiff;
  onResolve?: (path: string) => void;
  mutationBlocked?: boolean;
  activePath?: string | null;
  onActiveDiffChange?: (diff: ActiveDiffState | null) => void;
  onClose?: () => void;
  /** Optional lifted disclosure state (see `WorkingDisclosure`). Both props must be given for it to apply;
   * otherwise the component keeps its own, which then lasts only as long as it stays mounted. */
  disclosure?: WorkingDisclosure;
  onDisclosureChange?: (update: WorkingDisclosureUpdate) => void;
}) {
  const demo = isDemoHandle(session.handle);
  const key = draftKey(session);
  const composerId = useId();
  const [localDisclosure, setLocalDisclosure] = useState(DEFAULT_WORKING_DISCLOSURE);
  const ui = disclosure && onDisclosureChange ? disclosure : localDisclosure;
  const updateUi = (update: WorkingDisclosureUpdate) => { if (disclosure && onDisclosureChange) onDisclosureChange(update); else setLocalDisclosure(update); };
  const toggleSection = (kind: WorkingSection) => updateUi(current => ({ ...current, collapsed: { ...current.collapsed, [kind]: !current.collapsed[kind] } }));
  const [draft, setDraft] = useState(() => readDraft(key));
  const [amending, setAmending] = useState(false);
  const [amendDraft, setAmendDraft] = useState<CommitDraft | null>(null);
  const [amendHead, setAmendHead] = useState('');
  const [amendError, setAmendError] = useState('');
  const [persisted, setPersisted] = useState(true);
  const [selection, setSelection] = useState<{ group: WorkingGroup; path: string } | null>(null);
  const [preview, setPreview] = useState<{ target: string; scope: string; diff?: FileDiff; error?: string } | null>(null);
  const [operation, setOperation] = useState('');
  const [outcome, setOutcome] = useState<MutationOutcome | null>(null);
  useEffect(() => { if (!mutationBlocked) setOutcome(value => value?.refreshError ? { ...value, refreshError: undefined } : value); }, [revision, mutationBlocked]);
  const [success, setSuccess] = useState('');
  const { settings, updateSettings, openSettings } = useSettings();
  const profileKey = commitProfileRepositoryKey(session);
  const selectedProfile = settings.commitProfiles.find(profile => profile.id === settings.repositoryCommitProfiles[profileKey]);
  const identity = selectedProfile ? { name: selectedProfile.name, email: selectedProfile.email } : undefined;
  const identityName = selectedProfile?.name ?? 'Repository default';
  const identityControl = <details className="composer-identity" open={ui.identityOpen}>
    <summary title={selectedProfile ? `${selectedProfile.name} <${selectedProfile.email}>` : 'Uses the repository’s own Git identity'} onClick={event => { event.preventDefault(); updateUi(current => ({ ...current, identityOpen: !current.identityOpen })); }}>
      <User size={12} aria-hidden="true" /><span className="composer-identity-role">{amending ? 'Committer' : 'Commit as'}</span>{' '}<span className="composer-identity-name">{identityName}</span><ChevronDown size={12} className="composer-identity-chevron" aria-hidden="true" />
    </summary>
    <div className="composer-identity-panel"><label htmlFor={`${composerId}-identity`}>{amending ? 'Committer profile' : 'Commit as'}</label><select id={`${composerId}-identity`} value={selectedProfile?.id ?? ''} disabled={!!operation || busy || mutationBlocked} onChange={event => { const id = event.target.value; updateSettings(current => { const selections = { ...current.repositoryCommitProfiles }; if (id) selections[profileKey] = id; else delete selections[profileKey]; return { repositoryCommitProfiles: selections }; }); }}>
      <option value="">Repository Git identity (default)</option>
      {settings.commitProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.email}</option>)}
    </select><button type="button" className="text-button" onClick={() => openSettings('Commit profiles')}>Manage profiles…</button></div>
  </details>;
  const pending = useRef(false);
  const previousActivePath = useRef(activePath);
  const amendRequest = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const groups = statusGroups(status?.entries ?? []);
  const chosen = selection && groups[selection.group].some(entry => entry.path === selection.path) ? selection : null;
  const active = chosen;
  const target = JSON.stringify([session.handle, active?.group, active?.path]);
  const scope = JSON.stringify([target, revision]);
  const currentPreview = preview?.scope === scope ? preview : null;
  // Keep the same file/side visible during refresh, but never expose its old hunk token as actionable.
  const visiblePreview = preview?.target === target ? preview : null;
  useEffect(() => {
    let live = true;
    setPreview(current => current?.target === target ? current : null);
    if (!active || busy) return;
    loadDiff(session.handle, { kind: active.group }, active.path).then(diff => { if (live) setPreview({ target, scope, diff }); }).catch(error => { if (live) setPreview({ target, scope, error: errorMessage(error) }); });
    return () => { live = false; };
  }, [scope, busy, loadDiff]);

  useEffect(() => {
    if (previousActivePath.current && activePath === null) {
      setSelection(null);
    }
    previousActivePath.current = activePath;
  }, [activePath]);

  const stagePaths = operationPaths(status?.entries ?? [], 'stage');
  const stagedPaths = operationPaths(status?.entries ?? [], 'unstage');
  const stagedCount = groups.staged.length;
  // A conflict group that was folded away must not hide conflicts that appear later.
  const conflictCount = groups.conflict.length;
  const previousConflicts = useRef(conflictCount);
  useEffect(() => {
    if (previousConflicts.current === 0 && conflictCount > 0) updateUi(current => current.collapsed.conflict ? { ...current, collapsed: { ...current.collapsed, conflict: false } } : current);
    previousConflicts.current = conflictCount;
  }, [conflictCount]);
  const unstagedCount = groups.unstaged.length + groups.untracked.length;
  const blocked = busy || mutationBlocked || !!operation || !status || session.bare || !!outcome?.refreshError;
  const [menu, setMenu] = useState<FileMenuTarget | null>(null);
  const openMenu = (entry: StatusEntry, kind: WorkingGroup, x: number, y: number, trigger: HTMLElement) => setMenu({ entry, kind, x, y, trigger });
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setOutcome(null); setSuccess(`Copied ${label}.`); }
    catch { setOutcome({ error: 'Clipboard unavailable. Select the path in the file list instead.' }); }
  }
  /** Open and reveal only touch the user's desktop, never the repository, so they skip the write lock. */
  const fileAction = (command: 'repository_open_path' | 'repository_reveal_path', path: string) =>
    native(command, { handle: session.handle, path }).catch(error => { if (alive.current) setOutcome({ error: errorMessage(error) }); });
  const discardable = discardableEntries([...groups.unstaged, ...groups.untracked]).sort((a, b) => a.path.localeCompare(b.path));
  const [discarding, setDiscarding] = useState<{ entries: StatusEntry[]; fingerprint: string } | null>(null);
  const requestDiscard = (entries: StatusEntry[]) => { if (status && !blocked && entries.length) setDiscarding({ entries, fingerprint: status.fingerprint }); };
  function confirmDiscard() {
    if (!discarding) return;
    const { entries, fingerprint } = discarding;
    setDiscarding(null);
    void perform({ kind: 'discard', paths: entries.map(entry => entry.path), expectedStatusFingerprint: fingerprint }, entries.length);
  }

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
      diff: visiblePreview?.diff ?? null,
      error: visiblePreview?.error,
      loading: !visiblePreview,
      hunkAction: isStaged ? 'unstage_hunk' : active.group === 'unstaged' ? 'stage_hunk' : undefined,
      busy: blocked || !currentPreview,
      unavailable: demo ? 'Hunk staging is unavailable in the demo. Open a desktop repository to stage individual hunks.' : undefined,
      onHunk: mutation => { if (currentPreview && !busy) void perform(mutation); },
      onToggleStage: () => {
        const operationKind = isStaged ? 'unstage' : 'stage';
        const entry = groups[active.group].find(e => e.path === active.path);
        if (entry) void perform({ kind: operationKind, paths: operationPaths([entry], operationKind) });
      },
      isStaged,
    });
  }, [active, currentPreview, visiblePreview, busy, blocked, demo, onActiveDiffChange]);
  const composerDraft = amending ? amendDraft ?? { subject: '', body: '' } : draft;
  const amendReady = amending && !!amendDraft && !!session.head && amendHead === session.head && status?.head === session.head && status.headRef === session.headRef;
  function edit(value: CommitDraft) {
    if (amending) setAmendDraft(value);
    else { setDraft(value); setPersisted(saveDraft(key, value)); }
  }
  async function toggleAmend(enabled: boolean) {
    const token = ++amendRequest.current;
    setAmending(enabled); setAmendDraft(null); setAmendHead(''); setAmendError('');
    // Amend loads and edits a message the user must be able to see.
    if (enabled) updateUi(current => current.composerCollapsed ? { ...current, composerCollapsed: false } : current);
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
    setOperation(mutation.kind === 'commit' ? 'Creating commit and refreshing repository…' : mutation.kind === 'amend' ? 'Rewriting last commit and refreshing repository…' : `${mutation.kind === 'stage' || mutation.kind === 'stage_hunk' ? 'Staging' : mutation.kind === 'discard' ? 'Discarding' : mutation.kind === 'ignore' ? 'Ignoring' : 'Unstaging'} ${'hunkIndex' in mutation ? (hasLineIndices ? 'selected lines' : 'selected hunk') : `${fileCount} file${fileCount === 1 ? '' : 's'}`} and refreshing…`);
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
      else if (!result.error && !result.refreshError && mutation.kind === 'discard') setSuccess('Selected changes discarded.');
      else if (!result.error && !result.refreshError && mutation.kind === 'ignore') setSuccess('Added to .gitignore.');
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

  return <section className="working-inspector" aria-label="Working changes inspector" aria-busy={busy || !!operation}>
      <div className="working-sidebar-header">
        <div>
          <span className="eyebrow">{session.headRef?.replace('refs/heads/', '') ?? 'Detached HEAD'}</span>
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
      {outcome?.refreshError && <div className="workflow-alert error" role="alert">Refresh failed: {outcome.refreshError} <button className="text-button" onClick={() => void refresh()}>Retry</button></div>}
      <div className="working-feedback" role="status" aria-live="polite" aria-atomic="true" data-pending={busy || !!operation || undefined} title={operation || success || undefined}>
        {operation ? <><RotateCw size={12} className="spin" aria-hidden="true" /><span>{operation}</span></> : success ? <><Check size={12} aria-hidden="true" /><span>{success}</span></> : busy ? <span>Updating repository…</span> : null}
      </div>
      <div className="working-sidebar-content">
        <div className="file-list-actions">
          <button className="secondary-button" disabled={blocked || !unstagedCount} onClick={() => void perform({ kind: 'stage', paths: stagePaths }, unstagedCount)}>
            <Plus size={13} />Stage all ({unstagedCount})
          </button>
          <button className="secondary-button" disabled={blocked || !stagedCount} onClick={() => void perform({ kind: 'unstage', paths: stagedPaths }, stagedCount)}>
            <Minus size={13} />Unstage all ({stagedCount})
          </button>
          <button className="secondary-button" data-danger="true" disabled={blocked || !discardable.length} onClick={() => requestDiscard(discardable)}>
            <Undo2 size={13} />Discard all ({discardable.length})
          </button>
        </div>
        <div className="working-files-list">
          {SECTIONS.map(sectionKind => {
            const entries = sectionKind === 'unstaged' ? [...groups.unstaged, ...groups.untracked].sort((a, b) => a.path.localeCompare(b.path)) : groups[sectionKind];
            const collapsed = ui.collapsed[sectionKind];
            const listId = `${composerId}-${sectionKind}-files`;
            const holdsSelection = !!active && entries.some(entry => active.path === entry.path && active.group === (entry.untracked ? 'untracked' : sectionKind));
            return <section className={`working-category ${sectionKind}${entries.length ? ' has-entries' : ' is-empty'}${collapsed ? ' is-collapsed' : ''}`} key={sectionKind} aria-label={`${labels[sectionKind]} files`} hidden={sectionKind === 'conflict' && !entries.length}>
            <h2><button type="button" className="working-category-toggle" aria-expanded={!collapsed} aria-controls={listId} aria-label={`${labels[sectionKind]}, ${entries.length} ${entries.length === 1 ? 'file' : 'files'}`} data-holds-selection={holdsSelection || undefined} onClick={() => toggleSection(sectionKind)}>
              <ChevronDown size={13} className="working-category-chevron" aria-hidden="true" />{labels[sectionKind]}<span className="count">{entries.length}</span>
            </button></h2>
            <div className="working-category-files" id={listId} hidden={collapsed}>
            {!entries.length && <p className="empty-category">No {labels[sectionKind].toLowerCase()} files</p>}
            {entries.map(entry => {
              const kind = entry.untracked ? 'untracked' : sectionKind;
              const fileStatus = kind === 'staged' ? entry.indexStatus : entry.worktreeStatus;
              const isDeleted = fileStatus === 'D';
              const isNew = !isDeleted && (entry.untracked || entry.indexStatus === 'A');
              const iconStatus = entry.conflicted ? 'conflict' : isDeleted ? 'deleted' : isNew ? 'added' : fileStatus === 'C' ? 'copied' : fileStatus === 'R' ? 'renamed' : fileStatus === 'M' ? 'modified' : 'changed';
              const FileIcon = iconStatus === 'conflict' ? AlertTriangle : iconStatus === 'deleted' ? FileMinus2 : iconStatus === 'added' || iconStatus === 'copied' ? FilePlus2 : iconStatus === 'renamed' ? FileSymlink : iconStatus === 'modified' ? FilePenLine : FileCode2;
              const partial = groups.staged.some(item => item.path === entry.path) && groups.unstaged.some(item => item.path === entry.path);
              const isSelected = active?.group === kind && active.path === entry.path;
              return <div className={`working-file ${isSelected ? 'selected' : ''}`} key={entry.path} onContextMenu={event => { event.preventDefault(); openMenu(entry, kind, event.clientX, event.clientY, event.currentTarget.querySelector('button')!); }}>
                <button className="working-file-select" aria-pressed={isSelected} aria-label={`${labels[kind]}: ${entry.path}`} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(entry, kind, rect.left, rect.bottom, event.currentTarget); } }} onClick={() => setSelection(current => current?.group === kind && current.path === entry.path ? null : { group: kind, path: entry.path })}>
                  <FileIcon size={15} data-status={iconStatus} aria-label={iconStatus === 'added' ? 'New file' : `${iconStatus.charAt(0).toUpperCase()}${iconStatus.slice(1)} file`} />
                  <span>
                     <strong>{entry.path.split('/').map((part, index) => <Fragment key={index}>{index > 0 && <>/<wbr /></>}{part}</Fragment>)}</strong>
                    {entry.oldPath && <small>{(entry.indexStatus === 'C' || (entry.indexStatus !== 'R' && entry.worktreeStatus === 'C')) ? 'Copied' : 'Renamed'} from {entry.oldPath}</small>}
                    {partial && <small>Partially staged</small>}
                  </span>
                </button>
                {kind === 'conflict' && onResolve && <button className="secondary-button compact" disabled={busy} onClick={() => onResolve(entry.path)}>Resolve…</button>}
                {kind !== 'conflict' && <button className="icon-button sm file-stage-button" disabled={blocked} title={partial ? kind === 'staged' ? 'Unstage all indexed changes for this path' : 'Stage the remaining working-tree changes for this path' : undefined} aria-label={`${kind === 'staged' ? 'Unstage' : 'Stage'} ${entry.path}`} onClick={() => { const operationKind = kind === 'staged' ? 'unstage' : 'stage'; void perform({ kind: operationKind, paths: operationPaths([entry], operationKind) }); }}>{kind === 'staged' ? <Minus size={16} /> : <Plus size={16} />}</button>}
              </div>;
            })}
            </div>
          </section>; })}
        </div>
        <form className={`commit-composer${ui.composerCollapsed ? ' is-collapsed' : ''}`} aria-label="Commit composer" onSubmit={event => { event.preventDefault(); if (!composerDraft.subject.trim() || groups.conflict.length) return; if (amending && amendReady && status && session.head) void perform({ kind: 'amend', message: commitMessage(composerDraft), identity, expectedHead: session.head, expectedHeadRef: session.headRef, expectedStatusFingerprint: status.fingerprint }); else if (!amending && stagedCount) void perform({ kind: 'commit', message: commitMessage(composerDraft), identity }); }}>
          <div className="composer-heading">
            <h2><GitCommitHorizontal size={16} />{amending ? 'Rewrite last commit' : 'Create commit'}</h2>
            <span>{stagedCount} staged</span>
            {ui.composerCollapsed && !amending && !!(draft.subject.trim() || draft.body.trim()) && <em className="composer-draft" title="A commit message draft is waiting in the collapsed composer">Draft</em>}
            <button type="button" className="icon-button composer-toggle" aria-label={ui.composerCollapsed ? 'Expand commit composer' : 'Collapse commit composer'} aria-expanded={!ui.composerCollapsed} aria-controls={`${composerId}-composer-body`} onClick={() => updateUi(current => ({ ...current, composerCollapsed: !current.composerCollapsed }))}><ChevronDown size={14} aria-hidden="true" /></button>
          </div>
          {((amending && !amendDraft && !amendError) || !!amendError || !persisted) && <div className="composer-feedback">
            {amending && !amendDraft && !amendError && <p role="status">Loading last commit…</p>}
            {amendError && <p className="workflow-alert error" role="alert">{amendError}</p>}
            {!persisted && <small>Storage unavailable. Draft is kept for this session only.</small>}
          </div>}
          <div className="composer-body" id={`${composerId}-composer-body`} hidden={ui.composerCollapsed}>
            <div className="composer-options">
              <label className="amend-control"><input type="checkbox" checked={amending} disabled={!!operation || demo || !session.head} onChange={event => void toggleAmend(event.target.checked)} /><span>Amend last commit</span></label>
              {identityControl}
            </div>
            {amending && <small className="composer-amend-note">The original author is preserved when amending.</small>}
            <label htmlFor={`${composerId}-subject`}>Summary <span>required</span></label>
            <input id={`${composerId}-subject`} name="subject" placeholder="Describe what changed" autoComplete="off" value={composerDraft.subject} disabled={!!operation || (amending && !amendDraft)} onChange={event => edit({ ...composerDraft, subject: event.target.value })} />
            <label htmlFor={`${composerId}-body`}>Description <span>optional</span></label>
            <textarea id={`${composerId}-body`} name="body" placeholder="Add context: why was this change needed?" rows={2} value={composerDraft.body} disabled={!!operation || (amending && !amendDraft)} onChange={event => edit({ ...composerDraft, body: event.target.value })} />
            <div className="composer-footer">
              <button className="primary-button commit-button" data-working={operation.startsWith('Rewriting') || operation.startsWith('Creating')} type="submit" disabled={blocked || (!amending && !stagedCount) || (amending && !amendReady) || !composerDraft.subject.trim() || !!groups.conflict.length}>
                <GitCommitHorizontal size={16} />{operation.startsWith('Rewriting') ? 'Amending…' : operation.startsWith('Creating') ? 'Committing…' : amending ? 'Rewrite last commit' : 'Commit staged changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
      {menu && <FileContextMenu target={menu} blocked={blocked} native={!demo} onClose={() => setMenu(null)}
        onToggleStage={() => { const kind = menu.kind === 'staged' ? 'unstage' : 'stage'; void perform({ kind, paths: operationPaths([menu.entry], kind) }); }}
        onDiscard={() => requestDiscard([menu.entry])} onIgnore={() => void perform({ kind: 'ignore', path: menu.entry.path })}
        onCopy={(value, label) => void copy(value, label)} onOpen={() => void fileAction('repository_open_path', menu.entry.path)} onReveal={() => void fileAction('repository_reveal_path', menu.entry.path)} />}
      {discarding && <DiscardDialog entries={discarding.entries} blocked={blocked} onConfirm={confirmDiscard} onClose={() => setDiscarding(null)} />}
  </section>;
}

export { DiffPreview } from './DiffPreview';
