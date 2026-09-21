import { ChevronDown, ChevronRight, FolderGit2, GitBranch, Globe2, Plus, Tag } from 'lucide-react';
import { useState } from 'react';
import type { GitRef } from '../model/types';
import { ViewNavigation } from './WorkspaceControls';

export const repositories = [
  { id: 'gitty', name: 'gitty', path: '~/Developer/gitty', color: 'purple', language: 'TypeScript' },
  { id: 'orbit-design', name: 'orbit-design', path: '~/Developer/orbit-design', color: 'green', language: 'CSS' },
  { id: 'little-api', name: 'little-api', path: '~/Developer/little-api', color: 'amber', language: 'Rust' },
];

interface Props { repository: string; refs: GitRef[]; onRepository: (id: string) => void; onJump: (id: string, name?: string) => void; onAdd: () => void; activeRef: string | null; view: 'history' | 'working'; workingCount: number; onView: (view: 'history' | 'working') => void }

export function Sidebar({ repository, refs, onRepository, onJump, onAdd, activeRef, view, workingCount, onView }: Props) {
  const [collapsed, setCollapsed] = useState<string[]>(['Remotes']);
  function toggle(name: string) { setCollapsed(value => value.includes(name) ? value.filter(item => item !== name) : [...value, name]); }
  return <aside className="sidebar" aria-label="Repositories and references">
    <div className="workspace-label"><FolderGit2 size={22} /><span>Your workspace<small>Local demo repositories</small></span></div>
    <ViewNavigation view={view} count={workingCount} onChange={onView} />
    <div className="sidebar-section-title"><span>REPOSITORIES</span><button className="icon-button" aria-label="Choose a demo repository" onClick={onAdd}><Plus size={15} /></button></div>
    <nav aria-label="Repositories" className="repository-list">{repositories.map(repo => <button key={repo.id} className={`repository ${repo.id === repository ? 'active' : ''}`} aria-current={repo.id === repository ? 'page' : undefined} onClick={() => onRepository(repo.id)}>
      <FolderGit2 size={17} /><span>{repo.name}<small>{repo.path}</small></span>{repo.id === repository && <span className="repo-active-dot" />}
    </button>)}</nav>
    <div className="sidebar-divider" />
    {(['Branches', 'Remotes', 'Tags'] as const).map(section => {
      const kind = section === 'Branches' ? 'local' : section === 'Remotes' ? 'remote' : 'tag';
      const entries = refs.filter(ref => ref.kind === kind);
      const closed = collapsed.includes(section);
      const Icon = kind === 'tag' ? Tag : kind === 'remote' ? Globe2 : GitBranch;
      return <section className="refs-section" key={section}>
        <button className="refs-heading" aria-expanded={!closed} aria-controls={`refs-${kind}`} onClick={() => toggle(section)}>{closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<span>{section}</span><span className="count">{entries.length}</span></button>
        {!closed && <div id={`refs-${kind}`} className="refs-list">{entries.map(ref => <button key={ref.name} title={`Jump to ${ref.name}`} className={`ref-item ${activeRef === ref.name ? 'active' : ''}`} onClick={() => onJump(ref.commitId, ref.name)}><Icon size={13} /><span>{ref.name}</span>{ref.name === 'main' && <span className="current-branch-dot" />}</button>)}</div>}
      </section>;
    })}
    <div className="sidebar-bottom"><span className="eyebrow">DEMO WORKSPACE</span><p>Explore history and try staging. Changes are simulated in memory.</p><button disabled title="Branch operations require a desktop repository">Branch actions · desktop required</button></div>
  </aside>;
}
