import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Copy, FileCode2, GitCommitHorizontal, GitMerge, X } from 'lucide-react';
import type { Commit } from '../model/types';
import { diffLines } from '../model/diff';

interface Props { commit: Commit; head: string; onJump: (id: string) => void; onClose: () => void; notify: (message: string) => void }

export function Inspector({ commit, head, onJump, onClose, notify }: Props) {
  const [tab, setTab] = useState<'overview' | 'diff'>('overview');
  const [fileIndex, setFileIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setFileIndex(0); setCopied(false); }, [commit.id]);
  const file = commit.files[Math.min(fileIndex, commit.files.length - 1)];
  const additions = commit.files.reduce((n, f) => n + f.additions, 0);
  const deletions = commit.files.reduce((n, f) => n + f.deletions, 0);
  const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(commit.timestamp);
  async function copy() {
    try { await navigator.clipboard.writeText(commit.id); setCopied(true); notify('Full commit SHA copied'); }
    catch { notify('Clipboard unavailable. Select and copy the SHA in commit details.'); }
  }
  return <aside className="inspector" aria-label="Commit inspector">
    <div className="pane-heading"><span><GitCommitHorizontal size={17} /> Commit details</span><button className="icon-button" aria-label="Close commit inspector" onClick={onClose}><X size={15} /></button></div>
    <div className="inspector-tabs" role="tablist" aria-label="Commit detail view">
      {(['overview', 'diff'] as const).map((name, index) => <button key={name} id={`tab-${name}`} role="tab" aria-selected={tab === name} aria-controls={`panel-${name}`} tabIndex={tab === name ? 0 : -1} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'diff' : index === 0 ? 'diff' : 'overview'; setTab(next); document.getElementById(`tab-${next}`)?.focus(); } }}>
        {name === 'overview' ? 'Overview' : <>Diff <span className="count">{commit.files.length}</span></>}
      </button>)}
    </div>
    <div className="inspector-content" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      <div className="commit-summary">
        <div className="commit-eyebrow"><span>{commit.parents.length > 1 ? <GitMerge size={14} /> : <GitCommitHorizontal size={15} />}{commit.id.slice(0, 7)}</span>{commit.id === head && <span className="head-label">HEAD</span>}<button className="icon-button" aria-label="Copy full commit SHA" title="Copy full commit SHA" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></div>
        <h2>{commit.subject}</h2>
        <div className="author-block"><span className={`avatar color-${commit.author.charCodeAt(0) % 5}`}>{commit.author.split(' ').map(n => n[0]).join('')}</span><div><strong>{commit.author}</strong><span>{date} UTC</span></div></div>
      </div>
      {tab === 'overview' && <>
        <p className="commit-description">{commit.body}</p>
        <dl className="commit-metadata">
          <div><dt>Commit</dt><dd className="full-sha" title={commit.id}>{commit.id}</dd></div>
          <div><dt>{commit.parents.length === 1 ? 'Parent' : 'Parents'}</dt><dd>{commit.parents.length ? commit.parents.map(id => <button className="parent-link" key={id} onClick={() => onJump(id)}>{id.slice(0, 7)}<ArrowUpRight size={11} /></button>) : <span>Initial commit</span>}</dd></div>
          <div><dt>Author</dt><dd className="email">{commit.email}</dd></div>
        </dl>
      </>}
      <section className="changed-files" aria-label="Changed files">
        <div className="section-heading"><span><ChevronDown size={13} /> Changed files <span className="count">{commit.files.length}</span></span><span className="change-totals"><span className="added">+{additions}</span><span className="removed">−{deletions}</span></span></div>
        {commit.files.map((f, index) => <button key={f.path} className={`file-row ${tab === 'diff' && index === fileIndex ? 'active' : ''}`} onClick={() => { setFileIndex(index); setTab('diff'); }} title={`View mock diff for ${f.path}`}>
          <FileCode2 size={15} /><span className="file-name"><strong>{f.path.split('/').at(-1)}</strong><span>{f.path.split('/').slice(0, -1).join('/')}/</span></span><span className={`file-status ${f.status}`}>{f.status[0].toUpperCase()}</span>
        </button>)}
      </section>
      {tab === 'diff' ? <section className="diff-section" aria-label={`Mock diff for ${file.path}`}>
        <div className="diff-heading"><span>{file.path.split('/').at(-1)}</span><span className="mock-badge">MOCK DIFF</span></div>
        <div className="diff-code" tabIndex={0} aria-label="Scrollable unified diff">
          <div className="diff-hunk">@@ −{file.before.length ? 1 : 0},{file.before.length} +{file.after.length ? 1 : 0},{file.after.length} @@</div>
          {diffLines(file.before, file.after).map((line, index) => <div key={index} className={`diff-line ${line.kind}`}><span className="line-number">{line.oldLine ?? ''}</span><span className="line-number">{line.newLine ?? ''}</span><span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><code>{line.text || ' '}</code></div>)}
        </div>
        <p className="diff-note">Illustrative file contents from the demo repository.</p>
      </section> : <div className="inspector-tip"><FileCode2 size={17} /><p>A closer look, one file at a time.<br /><span>Select a file to explore its changes.</span></p></div>}
    </div>
    <div className="inspector-footer"><span className="live-dot" /> Synthetic history <span>Read-only preview</span></div>
  </aside>;
}
