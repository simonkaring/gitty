import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Copy, FileCode2, GitCommitHorizontal, GitMerge, X } from 'lucide-react';
import type { ChangedFile, Commit } from '../model/types';
import type { FileDiff } from '../model/repository';
import { diffLines } from '../model/diff';
import { useSettings } from '../model/settings';
import { DiffPreview, type ActiveDiffState } from './WorkingChanges';

interface Props {
  commit: Commit;
  head: string;
  onJump: (id: string) => void;
  onClose: () => void;
  notify: (message: string) => void;
  activePath?: string | null;
  onActiveDiffChange?: (diff: ActiveDiffState | null) => void;
}

function toFileDiff(f: ChangedFile): FileDiff {
  return {
    path: f.path,
    binary: false,
    truncated: false,
    message: null,
    hunks: [{
      header: `@@ −${f.before.length ? 1 : 0},${f.before.length} +${f.after.length ? 1 : 0},${f.after.length} @@`,
      lines: diffLines(f.before, f.after).map(line => ({
        kind: line.kind,
        content: line.text,
        oldLine: line.oldLine ?? null,
        newLine: line.newLine ?? null,
      })),
    }],
  };
}

export function Inspector({ commit, head, onJump, onClose, notify, activePath, onActiveDiffChange }: Props) {
  const { settings } = useSettings();
  const [split, setSplit] = useState(settings.diffView === 'split');
  useEffect(() => setSplit(settings.diffView === 'split'), [settings.diffView]);
  const [fileIndex, setFileIndex] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setFileIndex(0); setCopied(false); }, [commit.id]);

  useEffect(() => {
    if (!activePath) return;
    const index = commit.files.findIndex(f => f.path === activePath);
    if (index >= 0) {
      setFileIndex(index);
    }
  }, [activePath, commit.files]);

  const file = commit.files[Math.min(fileIndex, commit.files.length - 1)];
  const additions = commit.files.reduce((n, f) => n + f.additions, 0);
  const deletions = commit.files.reduce((n, f) => n + f.deletions, 0);
  const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(commit.timestamp);

  async function copy() {
    try { await navigator.clipboard.writeText(commit.id); setCopied(true); notify('Full commit SHA copied'); }
    catch { notify('Clipboard unavailable. Select and copy the SHA in commit details.'); }
  }

  function selectFile(index: number, f: ChangedFile) {
    setFileIndex(index);
    if (onActiveDiffChange) {
      onActiveDiffChange({
        path: f.path,
        diff: toFileDiff(f),
        loading: false,
      });
    }
  }

  return <aside className="inspector" aria-label="Commit inspector">
    <div className="inspector-content">
      <div className="commit-summary">
        <div className="commit-eyebrow">
          <span>{commit.parents.length > 1 ? <GitMerge size={14} /> : <GitCommitHorizontal size={15} />}{commit.id.slice(0, 7)}</span>
          {commit.id === head && <span className="head-label">HEAD</span>}
          <div className="commit-actions">
            <button className="icon-button" aria-label="Copy full commit SHA" title="Copy full commit SHA" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
            <button className="icon-button" aria-label="Close commit inspector" title="Close commit inspector" onClick={onClose}><X size={15} /></button>
          </div>
        </div>
        <h2>{commit.subject}</h2>
        <div className="author-block"><span className={`avatar color-${commit.author.charCodeAt(0) % 5}`}>{commit.author.split(' ').map(n => n[0]).join('')}</span><div><strong>{commit.author}</strong><span>{date} UTC</span></div></div>
      </div>
      <p className="commit-description">{commit.body}</p>
      <dl className="commit-metadata">
        <div><dt>Commit</dt><dd className="full-sha" title={commit.id}>{commit.id}</dd></div>
        <div><dt>{commit.parents.length === 1 ? 'Parent' : 'Parents'}</dt><dd>{commit.parents.length ? commit.parents.map(id => <button className="parent-link" key={id} onClick={() => onJump(id)}>{id.slice(0, 7)}<ArrowUpRight size={11} /></button>) : <span>Initial commit</span>}</dd></div>
        <div><dt>Author</dt><dd className="email">{commit.email}</dd></div>
      </dl>
      <section className="changed-files" aria-label="Changed files">
        <div className="section-heading"><span><ChevronDown size={13} /> Changed files <span className="count">{commit.files.length}</span></span><span className="change-totals"><span className="added">+{additions}</span><span className="removed">−{deletions}</span></span></div>
        {commit.files.map((f, index) => {
          const isSelected = activePath ? f.path === activePath : index === fileIndex;
          return <button key={f.path} className={`file-row ${isSelected ? 'active' : ''}`} onClick={() => selectFile(index, f)} title={`View diff for ${f.path}`}>
            <FileCode2 size={15} /><span className="file-name"><strong>{f.path.split('/').at(-1)}</strong><span>{f.path.split('/').slice(0, -1).join('/')}/</span></span><span className={`file-status ${f.status}`}>{f.status[0].toUpperCase()}</span>
          </button>;
        })}
      </section>
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
        file ? <section className="diff-section" aria-label={`Mock diff for ${file.path}`}>
          <div className="diff-heading"><span>{file.path.split('/').at(-1)}</span><button aria-pressed={split} onClick={() => setSplit(!split)}>{split ? 'Unified' : 'Side by side'}</button><span className="mock-badge">MOCK DIFF</span></div>
          {split ? <DiffPreview split diff={toFileDiff(file)} /> : <div className="diff-code" tabIndex={0} aria-label="Scrollable unified diff">
            <div className="diff-hunk">@@ −{file.before.length ? 1 : 0},{file.before.length} +{file.after.length ? 1 : 0},{file.after.length} @@</div>
            {diffLines(file.before, file.after).map((line, index) => <div key={index} className={`diff-line ${line.kind}`}><span className="line-number">{line.oldLine ?? ''}</span><span className="line-number">{line.newLine ?? ''}</span><span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><code>{line.text || ' '}</code></div>)}
          </div>}
          <p className="diff-note">Illustrative file contents from the demo repository.</p>
        </section> : <div className="inspector-tip"><FileCode2 size={17} /><p>Select a file to inspect its changes.</p></div>
      )}
    </div>
    <div className="inspector-footer"><span className="live-dot" /> Synthetic history <span>Read-only preview</span></div>
  </aside>;
}
