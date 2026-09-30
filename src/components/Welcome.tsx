import { useEffect, useState } from 'react';
import { FolderGit2, FolderOpen, Sparkles } from 'lucide-react';
import type { RepositoryLocation } from '../model/repository';
import { native } from '../model/native';
import { locationLabel } from '../model/tabs';

/** Lanes for the decorative background graph: [x, fromY, toY, color var]. */
const LANES: [number, number, number, string][] = [[40, 0, 600, '--graph-lane1'], [80, 90, 420, '--graph-lane2'], [120, 200, 520, '--graph-lane3'], [160, 60, 260, '--graph-lane4']];
const NODES: [number, number, string][] = [[40, 50, '--graph-lane1'], [80, 130, '--graph-lane2'], [40, 170, '--graph-lane1'], [160, 110, '--graph-lane4'], [120, 250, '--graph-lane3'], [80, 300, '--graph-lane2'], [40, 340, '--graph-lane1'], [160, 220, '--graph-lane4'], [120, 400, '--graph-lane3'], [40, 460, '--graph-lane1'], [120, 480, '--graph-lane3'], [80, 380, '--graph-lane2']];

function GraphArt() {
  return <svg className="welcome-graph" viewBox="0 0 200 600" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
    {LANES.map(([x, y1, y2, color], i) => <path key={i} d={`M${x} ${y1} V${y2}`} style={{ stroke: `var(${color})`, animationDelay: `${i * 180}ms` }} />)}
    <path d="M80 130 C80 150 40 150 40 170" style={{ stroke: 'var(--graph-lane2)', animationDelay: '500ms' }} />
    <path d="M120 250 C120 280 80 280 80 300" style={{ stroke: 'var(--graph-lane3)', animationDelay: '700ms' }} />
    <path d="M160 220 C160 240 120 240 120 250" style={{ stroke: 'var(--graph-lane4)', animationDelay: '900ms' }} />
    {NODES.map(([x, y, color], i) => <circle key={i} cx={x} cy={y} r="5" style={{ fill: `var(${color})`, animationDelay: `${300 + i * 90}ms` }} />)}
  </svg>;
}

export function Welcome({ showRecent, onOpenPicker, onOpen, onDemo }: { showRecent: boolean; onOpenPicker: () => void; onOpen: (location: RepositoryLocation) => void; onDemo: () => void }) {
  const [recent, setRecent] = useState<RepositoryLocation[]>([]);
  // ponytail: recent list is a nicety; a failed read just leaves it empty.
  useEffect(() => { let live = true; native<RepositoryLocation[]>('repository_recent').then(v => { if (live && Array.isArray(v)) setRecent(v.slice(0, 6)); }).catch(() => {}); return () => { live = false; }; }, []);
  return <main className="native-welcome">
    <GraphArt />
    <div className="welcome-body">
      <span className="welcome-mark"><FolderGit2 size={22} /></span>
      <h1>Open a repository to begin.</h1>
      <p>See every branch as a graph, stage exactly what you mean, and commit with confidence.</p>
      <div className="welcome-actions">
        <button className="primary-button" onClick={onOpenPicker}><FolderOpen size={16} />Open repository</button>
        <button className="text-button" onClick={onDemo}><Sparkles size={15} />Explore a demo workspace</button>
      </div>
      {showRecent && recent.length > 0 && <nav className="welcome-recent" aria-label="Recent repositories">
        <h2>Recent</h2>
        {recent.map((location, i) => <button key={JSON.stringify(location)} style={{ animationDelay: `${i * 50}ms` }} onClick={() => onOpen(location)}>
          <FolderGit2 size={15} /><strong>{locationLabel(location)}</strong><small>{location.path}</small>
        </button>)}
      </nav>}
    </div>
  </main>;
}
