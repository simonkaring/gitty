import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { AlertTriangle, Check, ChevronDown, FileCode2, FileMinus2, FilePenLine, FilePlus2, FileSymlink, GitCommitHorizontal, Minus, Plus, RotateCw, Undo2, User, X } from 'lucide-react';
import type { CommitDetail, DiffSpec, FileDiff, RepositoryMutation, RepositorySession, RepositoryStatus, StatusEntry } from '../model/repository';
import { errorMessage, isDemoHandle, native, statusGroups, type WorkingGroup } from '../model/native';
import { clearSubmittedDraft, commitMessage, discardableEntries, draftFromCommitMessage, draftKey, operationPaths, readDraft, saveDraft, type CommitDraft, type MutationOutcome } from '../model/workflow';
import { useSettings } from '../model/settings';
import { commitProfileRepositoryKey } from '../model/commitProfiles';
import { DiscardDialog } from './DiscardDialog';
import { FileContextMenu, type FileMenuTarget } from './FileContextMenu';
import { splitDiffRows, type SplitDiffLine } from '../model/splitDiff';

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
  const [preview, setPreview] = useState<{ scope: string; diff?: FileDiff; error?: string } | null>(null);
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
  const scope = JSON.stringify([session.handle, active?.group, active?.path, revision, busy]);
  const currentPreview = preview?.scope === scope ? preview : null;
  useEffect(() => {
    let live = true;
    setPreview(null);
    if (!active || busy) return;
    loadDiff(session.handle, { kind: active.group }, active.path).then(diff => { if (live) setPreview({ scope, diff }); }).catch(error => { if (live) setPreview({ scope, error: errorMessage(error) }); });
    return () => { live = false; };
  }, [scope, loadDiff]);

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

  return <section className="working-inspector" aria-label="Working changes inspector" aria-busy={!!operation}>
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
      {success && <div className="workflow-status" role="status"><Check size={14} />{success}</div>}
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
  const lineDigits = diff.hunks.reduce((max, hunk) => hunk.lines.reduce((digits, line) => Math.max(digits, String(line.oldLine ?? '').length, String(line.newLine ?? '').length), max), 4);
  const splitSurface = useRef<HTMLDivElement>(null);
  const horizontalScroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const surface = splitSurface.current;
    const scrollbar = horizontalScroll.current;
    if (!split || !surface || !scrollbar) return;
    let live = true;
    const measure = () => {
      if (!live) return;
      const wrapped = document.documentElement.dataset.diffWrap === 'true';
      const overflow = wrapped ? 0 : Math.max(0, ...Array.from(surface.querySelectorAll<HTMLElement>('.split-code')).map(code => code.scrollWidth - code.clientWidth));
      const track = scrollbar.firstElementChild as HTMLElement;
      track.style.width = `${surface.clientWidth + overflow}px`;
      scrollbar.style.display = overflow > 0 ? 'block' : 'none';
      if (wrapped) scrollbar.scrollLeft = 0;
      surface.style.setProperty('--split-scroll-offset', `${scrollbar.scrollLeft}px`);
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(surface);
    if (surface.firstElementChild) observer?.observe(surface.firstElementChild);
    const preferences = new MutationObserver(measure);
    preferences.observe(document.documentElement, { attributes: true, attributeFilter: ['data-diff-wrap', 'style'] });
    measure();
    const wheel = (event: WheelEvent) => {
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta || scrollbar.style.display === 'none') return;
      const previous = scrollbar.scrollLeft;
      scrollbar.scrollLeft += delta * (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? surface.clientWidth : 1);
      if (scrollbar.scrollLeft !== previous) {
        event.preventDefault();
        surface.style.setProperty('--split-scroll-offset', `${scrollbar.scrollLeft}px`);
      }
    };
    surface.addEventListener('wheel', wheel, { passive: false });
    void document.fonts?.ready.then(measure);
    return () => { live = false; observer?.disconnect(); preferences.disconnect(); surface.removeEventListener('wheel', wheel); };
  }, [split, diff]);

  function splitCell(item: SplitDiffLine | undefined, side: 'before' | 'after', hunkIndex: number) {
    if (!item) return <div className="split-cell split-cell-empty" aria-hidden="true"><span className="split-gutter" /><span className="split-code" /></div>;
    const { line, index: lineIndex } = item;
    const selectable = !!hunkAction && !reason && !!fingerprint && (line.kind === 'add' || line.kind === 'remove');
    const isSelected = selectable && (selected[hunkIndex] ?? []).includes(lineIndex);
    const number = side === 'before' ? line.oldLine : line.newLine;
    return <div className={`split-cell ${line.kind}${isSelected ? ' selected-line' : ''}`}>
      <span className="split-gutter"><span className="split-line-action">{selectable && <button type="button" className="line-select-toggle" aria-pressed={isSelected} disabled={busy} title={`${isSelected ? 'Deselect' : 'Select'} line for ${actionVerb}`} aria-label={`${isSelected ? 'Deselect' : 'Select'} line ${number ?? ''} for ${actionVerb} (${side})`} onClick={() => toggleLine(hunkIndex, lineIndex)}>{isSelected && <Check size={10} strokeWidth={3} aria-hidden="true" />}</button>}</span><span className="split-line-number">{number ?? ''}</span><span className="split-line-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}</span></span>
      <pre className="split-code">{line.content}</pre>
    </div>;
  }

  return <><div className="diff-messages" role="status">{diff.binary && <p>Binary file · textual preview unavailable.</p>}{diff.truncated && <p>Diff truncated · only the available preview is shown.</p>}{diff.message && <p>{diff.message}</p>}{reason && <p className="hunk-unavailable">{reason}</p>}{!diff.hunks.length && !diff.binary && <p>No textual hunks · metadata-only or empty file change.</p>}</div><div ref={splitSurface} className={`native-diff ${split ? 'split' : ''}`} tabIndex={0} aria-label={`${split ? 'Side-by-side' : 'Unified'} diff for ${diff.path}`}>
    <div className={split ? 'split-content' : 'unified-content'} style={split ? { '--split-line-number-width': `${lineDigits}ch` } as CSSProperties : undefined}>
    {split && !!diff.hunks.length && <div className="split-column-header"><span><span className="split-side-dot before" />Before<small>Original</small></span><span><span className="split-side-dot after" />After<small>Modified</small></span></div>}
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
        {split ? splitDiffRows(hunk.lines).map((row, rowIndex) => row.meta ? <pre className="split-meta" key={rowIndex}>{row.meta.line.content}</pre> : <div className="split-row" key={rowIndex}>{splitCell(row.before, 'before', index)}{splitCell(row.after, 'after', index)}</div>) : hunk.lines.map((line, i) => {
          const isSelectable = !!hunkAction && !reason && !!fingerprint && (line.kind === 'add' || line.kind === 'remove');
          const isSelected = isSelectable && hunkSelected.includes(i);
          const lineNum = line.kind === 'add' ? line.newLine : line.oldLine;

          return (
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
    </div>
  </div>{split && <div ref={horizontalScroll} className="split-horizontal-scroll" tabIndex={0} role="region" aria-label="Scroll both diff sides horizontally" onScroll={event => splitSurface.current?.style.setProperty('--split-scroll-offset', `${event.currentTarget.scrollLeft}px`)}><div /></div>}</>;
}
