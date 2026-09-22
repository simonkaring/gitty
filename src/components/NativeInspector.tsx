import { useEffect, useMemo, useState } from 'react';
import type { CommitDetail, DiffFile, FileDiff, RepositorySession, RepositoryStatus } from '../model/repository';
import { errorMessage, inspectorSpec, native, statusGroups, WORKING_ID, type WorkingGroup } from '../model/native';
import { X } from 'lucide-react';
import { DiffPreview, type ActiveDiffState } from './WorkingChanges';
import { useSettings } from '../model/settings';

export function NativeInspector({ session, selected, status, revision, base, target, onJump, onBase, onTarget, onSwap, onClear, onClose, activePath, onActiveDiffChange }: {
  session: RepositorySession; selected: string; status: RepositoryStatus | null; revision: number;
  base: string; target: string; onJump: (id: string) => void; onBase: () => void; onTarget: () => void; onSwap: () => void; onClear: () => void;
  onClose: () => void;
  activePath?: string | null;
  onActiveDiffChange?: (diff: ActiveDiffState | null) => void;
}) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [parent, setParent] = useState('');
  const [group, setGroup] = useState<WorkingGroup>('unstaged');
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [path, setPath] = useState('');
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState('');
  const [diffError, setDiffError] = useState('');
  const [filesScope, setFilesScope] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
  const { settings } = useSettings();
  const [split, setSplit] = useState(settings.diffView === 'split');
  useEffect(() => setSplit(settings.diffView === 'split'), [settings.diffView]);
  const [expanded, setExpanded] = useState(false);
  const working = selected === WORKING_ID;
  const groups = statusGroups(status?.entries ?? []);
  useEffect(() => { setParent(''); setDetail(null); setError(''); setDiffError(''); setDiffBusy(false); }, [selected]);
  const validParent = detail?.id === selected && detail.parents.includes(parent) ? parent : undefined;
  const spec = useMemo(() => inspectorSpec(selected, group, base, target, validParent), [base, target, group, selected, validParent]);
  const comparing = spec.kind === 'compare';
  const scope = JSON.stringify([selected, spec, revision, retry]);
  useEffect(() => {
    let live = true;
    setBusy(true); setError(''); setDiffError(''); setDiffBusy(false); setFiles([]); setFilesScope(''); setDiff(null);
    Promise.all([
      !working && selected ? native<CommitDetail>('repository_commit', { handle: session.handle, oid: selected }) : Promise.resolve(null),
      selected ? native<DiffFile[]>('repository_diff_files', { handle: session.handle, spec }) : Promise.resolve([]),
    ]).then(([commit, list]) => { if (live) { setDetail(commit); setFiles(list); setFilesScope(scope); setPath(old => old && list.some(file => file.path === old) ? old : onActiveDiffChange ? '' : list[0]?.path ?? ''); } })
      .catch(e => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [session.handle, selected, working, spec, revision, retry, scope, onActiveDiffChange]);

  useEffect(() => {
    if (activePath === null && path !== '') setPath('');
  }, [activePath, path]);

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
    setDiff(null); setDiffBusy(false); setDiffError('');
    if (!path || busy || filesScope !== scope || !files.some(file => file.path === path)) return;
    setDiffBusy(true);
    native<FileDiff>('repository_diff', { handle: session.handle, spec, path }).then(result => { if (live) setDiff(result); })
      .catch(e => { if (live) setDiffError(errorMessage(e)); }).finally(() => { if (live) setDiffBusy(false); });
    return () => { live = false; };
  }, [session.handle, spec, path, files, busy, retry, scope, filesScope]);
  return <aside className={`native-inspector ${expanded ? 'expanded' : ''}`} aria-label="Change inspector">
    <div className="native-actions"><strong>{working ? 'Working changes' : comparing ? 'Commit comparison' : 'Commit inspector'}</strong><button onClick={() => setExpanded(!expanded)} aria-pressed={expanded}>{expanded ? 'Reduce width' : 'Expand diff'}</button><button className="icon-button" aria-label="Close commit inspector" onClick={onClose}><X size={17} /></button></div>
    {(error || diffError) && <div role="alert">{error || diffError} <button onClick={() => setRetry(retry + 1)}>Retry inspection</button></div>}
    {busy && <p role="status">Loading details and files…</p>}
    {!working && selected && <><h2>{detail?.subject}</h2><code className="native-sha">{selected}</code><p>{detail?.author} {detail && new Date(detail.timestamp * 1000).toLocaleString()}</p><pre className="commit-body">{detail?.body}</pre>
      <div className="native-actions"><button onClick={onBase}>Set as base</button><button onClick={onTarget}>Set as target</button></div>
      {!comparing && detail?.parents.length === 0 && <p>Root commit · changes from the empty tree to this commit</p>}
      {!comparing && !!detail?.parents.length && <><label>Changes from parent to selected commit <select value={validParent ?? detail.parents[0]} onChange={e => setParent(e.target.value)}>{detail.parents.map((id, index) => <option key={id} value={id}>Parent {index + 1}: {id.slice(0, 12)}</option>)}</select></label><div className="native-actions">{detail.parents.map(id => <button key={id} onClick={() => onJump(id)}>Reveal {id.slice(0, 7)}</button>)}</div></>}
    </>}
    {!working && (base || target) && <div className="compare-summary"><p>Base: {base.slice(0, 12) || 'not selected'} → Target: {target.slice(0, 12) || 'not selected'}</p><p>{comparing ? 'Changes that turn the base commit into the target commit. Removed lines belong to base; added lines belong to target.' : 'Choose both commits to compare. Currently showing the selected commit’s changes.'}</p><button disabled={!base || !target} onClick={onSwap}>Swap direction</button> <button onClick={onClear}>Clear comparison</button></div>}
    {working && <p>{group === 'staged' ? 'Staged: changes from HEAD to the index (staging area).' : group === 'unstaged' ? 'Unstaged: changes from the index to the working tree.' : group === 'untracked' ? 'Untracked: files in the working tree that are not in the index.' : 'Conflicts: unresolved paths in the index and working tree.'}</p>}
    {working && base && target && <p>Saved commit comparison is paused while viewing working changes.</p>}
    {working && <div className="working-groups" aria-label="Working change categories">{(Object.keys(groups) as WorkingGroup[]).map(kind => <button key={kind} aria-pressed={group === kind} onClick={() => setGroup(kind)}>{kind} ({groups[kind].length})</button>)}</div>}
    <div className="native-files" aria-label="Changed files">{files.map(file => <button key={file.path} aria-pressed={file.path === path} onClick={() => setPath(file.path)}><span>{file.status} {file.oldPath ? `${file.oldPath} → ` : ''}{file.path}</span><small>{file.binary ? 'Binary' : `+${file.additions ?? '?'} −${file.deletions ?? '?'}`}</small></button>)}</div>
    {!busy && !files.length && <p>No changed files in this comparison.</p>}
    {!onActiveDiffChange && <>
      {path && filesScope === scope && <div className="native-actions"><strong>{path}</strong><button aria-pressed={split} onClick={() => setSplit(!split)}>{split ? 'Unified diff' : 'Side-by-side diff'}</button></div>}
      {diffBusy && <p role="status">Loading diff…</p>}
      {diff && <DiffPreview diff={diff} split={split} />}
    </>}
  </aside>;
}
