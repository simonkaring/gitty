import { ChevronDown, FolderGit2, GitBranch, GitCommitHorizontal, Globe2, LocateFixed, Search, Tag, X } from 'lucide-react';
import { useState, type ReactNode, type RefObject } from 'react';
import type { GitRef } from '../model/types';

export const repositories = [
  { id: 'gitty', name: 'gitty', path: '~/Developer/gitty', color: 'purple', language: 'TypeScript' },
  { id: 'orbit-design', name: 'orbit-design', path: '~/Developer/orbit-design', color: 'green', language: 'CSS' },
  { id: 'little-api', name: 'little-api', path: '~/Developer/little-api', color: 'amber', language: 'Rust' },
];

export interface SidebarProps {
  repository: string;
  refs: GitRef[];
  onRepository?: (id: string) => void;
  onJump: (id: string, name?: string) => void;
  onSwitchBranch?: (name: string) => void;
  onAdd?: () => void;
  activeRef: string | null;
  view?: 'history' | 'working';
  workingCount?: number;
  onView?: (view: 'history' | 'working') => void;
  commitCount?: number;
  query?: string;
  setQuery?: (value: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  nextResult?: (direction: number) => void;
  onHead?: () => void;
  refMenu?: boolean;
  setRefMenu?: (value: boolean | ((val: boolean) => boolean)) => void;
  refMenuRef?: RefObject<HTMLDivElement | null>;
  toolbar?: ReactNode;
  historyTitle?: ReactNode;
}

export function Sidebar({
  repository,
  refs,
  onJump,
  onSwitchBranch,
  activeRef,
  commitCount,
  query,
  setQuery,
  searchRef,
  nextResult,
  onHead,
  refMenu,
  setRefMenu,
  refMenuRef,
  toolbar,
  historyTitle,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<string[]>(['Remotes']);
  function toggle(name: string) { setCollapsed(value => value.includes(name) ? value.filter(item => item !== name) : [...value, name]); }

  const repoInfo = repositories.find(repo => repo.id === repository);

  return <aside className="sidebar" aria-label="References">
    <div className="workspace-label repository-heading">
      <div className="repository-heading-main">
        <div className="repo-title-icon"><FolderGit2 size={22} strokeWidth={1.6} /></div>
        <div>
          <div className="repo-title-line">
            <h1>{repository}</h1>
            <span className="local-badge">DEMO</span>
          </div>
          <p>{repoInfo?.path ?? 'Local demo repository'}</p>
        </div>
      </div>
      <span className="branch-heading"><GitBranch size={14} /> main <span className="live-dot" /></span>
    </div>
    <div className="sidebar-divider" />
    {toolbar ?? (query !== undefined && setQuery && (
      <div className="history-toolbar">
        <div className="ref-menu-wrapper" ref={refMenuRef}>
          <button
            className={`branch-filter ${refMenu ? 'active' : ''}`}
            onClick={() => setRefMenu?.(value => !value)}
            aria-expanded={refMenu}
            aria-controls="branch-jump-menu"
          >
            <GitBranch size={14} /><span>All branches</span><ChevronDown size={12} />
          </button>
          {refMenu && <div className="ref-menu" id="branch-jump-menu">
            <span className="menu-label">JUMP TO A REFERENCE</span>
            {refs.map(ref => <button key={ref.name} onClick={() => onJump(ref.commitId, ref.name)}><GitBranch size={13} /><span>{ref.name}</span></button>)}
            <p>All branches stay visible to preserve the graph.</p>
          </div>}
        </div>
        <div className="search-field">
          <Search size={14} />
          <input
            ref={searchRef}
            aria-label="Search commits, authors, branches, or SHA"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search commits…"
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); nextResult?.(event.shiftKey ? -1 : 1); } }}
          />
          {query ? <button className="icon-button" aria-label="Clear search" onClick={() => { setQuery(''); searchRef?.current?.focus(); }}><X size={13} /></button> : <kbd>/</kbd>}
        </div>
        {onHead && (
          <button className="head-button" title="Jump to HEAD (H)" onClick={onHead}>
            <LocateFixed size={15} /><span>HEAD</span>
          </button>
        )}
      </div>
    ))}
    {(['Branches', 'Remotes', 'Tags'] as const).map(section => {
      const kind = section === 'Branches' ? 'local' : section === 'Remotes' ? 'remote' : 'tag';
      const entries = refs.filter(ref => ref.kind === kind);
      const closed = collapsed.includes(section);
      const Icon = kind === 'tag' ? Tag : kind === 'remote' ? Globe2 : GitBranch;
      return <section className="refs-section" key={section}>
        <button className="refs-heading" aria-expanded={!closed} aria-controls={`refs-${kind}`} onClick={() => toggle(section)}><ChevronDown size={13} /><span>{section}</span><span className="count">{entries.length}</span></button>
        {!closed && <div id={`refs-${kind}`} className="refs-list">{entries.map(ref => <button key={ref.name} title={`Jump to ${ref.name}${kind === 'local' ? ' · double-click to switch' : ''}`} className={`ref-item ${activeRef === ref.name ? 'active' : ''}`} onClick={() => onJump(ref.commitId, ref.name)} onDoubleClick={() => { if (kind === 'local') onSwitchBranch?.(ref.name); }}><Icon size={13} /><span>{ref.name}</span>{ref.name === 'main' && <span className="current-branch-dot" />}</button>)}</div>}
      </section>;
    })}
    {historyTitle ?? (commitCount !== undefined && (
      <div className="history-title">
        <span><GitCommitHorizontal size={18} /><h2>History</h2><span className="count">{commitCount.toLocaleString()}</span></span>
        <span className="history-subtitle">The full picture of your work.</span>
      </div>
    ))}
    <div className="sidebar-bottom"><span className="eyebrow">DEMO WORKSPACE</span><p>Explore history and try staging. Changes are simulated in memory.</p><button disabled title="Branch operations require a desktop repository">Branch actions · desktop required</button></div>
  </aside>;
}
