import type { ChangedFile, Commit, HistoryProvider, RepositorySnapshot } from './types';

const authors = ['Alex Morgan', 'Jamie Chen', 'Sam Rivera', 'Taylor Kim', 'Jordan Lee'];
const subjects = [
  'Improve command palette spacing',
  'Keep your place when switching branches',
  'Polish the empty state for new repositories',
  'Add keyboard shortcuts to the history view',
  'Bring a softer contrast to dark mode',
  'Remember panel sizes between sessions',
  'Make commit details easier to scan',
  'Handle shallow histories gracefully',
  'Tighten up spacing in the repository list',
  'Improve focus rings for keyboard navigation',
  'Cache graph positions across history pages',
  'Respect reduced motion preferences',
];

function hash(value: number, salt: number): string {
  let x = (value + salt * 7919) >>> 0;
  let result = '';
  for (let i = 0; i < 5; i++) {
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    result += ((x ^ (x >>> 16)) >>> 0).toString(16).padStart(8, '0');
  }
  return result;
}

function filesFor(index: number): ChangedFile[] {
  const paths = ['src/components/CommandPalette.tsx', 'src/styles/tokens.css', 'src/hooks/useRepository.ts', 'src/components/HistoryView.tsx'];
  return Array.from({ length: 1 + index % 3 }, (_, n) => {
    const path = paths[(index + n) % paths.length];
    const before = path.endsWith('.css')
      ? [':root {', '  --panel-radius: 8px;', '  --focus-color: #8890a0;', '  --row-height: 40px;', '}']
      : ['export const viewOptions = {', '  preserveSelection: false,', '  overscan: 4,', '  keyboardNavigation: true,', '};'];
    const after = path.endsWith('.css')
      ? [':root {', '  --panel-radius: 4px;', '  --focus-color: #277c6f;', '  --row-height: 48px;', '  --motion-duration: 120ms;', '}']
      : ['export const viewOptions = {', '  preserveSelection: true,', '  overscan: 12,', '  keyboardNavigation: true,', '  restoreScrollPosition: true,', '};'];
    const status = (index + n) % 13 === 0 ? 'added' : (index + n) % 17 === 0 ? 'deleted' : 'modified';
    const oldLines = status === 'added' ? [] : before;
    const newLines = status === 'deleted' ? [] : after;
    return { path, status, before: oldLines, after: newLines, additions: newLines.filter(line => !oldLines.includes(line)).length, deletions: oldLines.filter(line => !newLines.includes(line)).length };
  });
}

/** Chronological construction guarantees a DAG; output is reverse topological. */
export function createDemoHistory(seed = 1, rounds = 140): RepositorySnapshot {
  const chronological: Commit[] = [];
  const tips = new Map<string, string>();
  function commit(branch: string, subject?: string, additional: string[] = []) {
    const index = chronological.length;
    const author = authors[(index + seed) % authors.length];
    const parent = tips.get(branch);
    const parents = [...new Set([...(parent ? [parent] : []), ...additional])];
    const id = hash(index + 1, seed);
    chronological.push({
      id, parents, subject: subject ?? subjects[(index + Math.floor(index / 12) + seed) % subjects.length],
      body: parents.length > 1
        ? 'Bring the latest work together while preserving the full branch history.\n\nReviewed with the team and ready for the next release.'
        : 'Improve readability in the history workspace and commit inspector.\n\nPreserve selection and scroll position when repository state changes.',
      author, email: `${author.toLowerCase().replace(' ', '.')}@example.com`,
      timestamp: Date.UTC(2026, 8, 18, 16, 42) - (rounds * 12 - index) * 37 * 60_000,
      branch, files: filesFor(index + seed),
    });
    tips.set(branch, id);
    return id;
  }
  commit('main', 'Initialize the repository');
  for (let i = 0; i < rounds; i++) {
    const base = tips.get('main')!;
    tips.set('feature/command-palette', base);
    tips.set('docs/getting-started', base);
    commit('feature/command-palette');
    commit('main');
    commit('docs/getting-started', 'Document the repository workflow');
    commit('feature/command-palette');
    const hotfixBase = tips.get('main')!;
    tips.set('fix/focus-ring', hotfixBase);
    commit('fix/focus-ring', 'Keep focus visible when the inspector opens');
    commit('main');
    commit('feature/command-palette', 'Sync the palette with the latest main', [tips.get('main')!]);
    commit('main', 'Merge branch ‘fix/focus-ring’', [tips.get('fix/focus-ring')!]);
    commit('feature/command-palette', 'Refine command groups and quick actions');
    commit('main', i % 4 === 0 ? 'Merge palette, docs, and focus improvements' : 'Merge branch ‘feature/command-palette’', [tips.get('feature/command-palette')!, ...(i % 4 === 0 ? [tips.get('docs/getting-started')!] : [])]);
    commit('main', 'Merge branch ‘docs/getting-started’', [tips.get('docs/getting-started')!]);
    commit('main');
  }
  const release = tips.get('main')!;
  commit('feature/command-palette', 'Add recent repositories to the command palette');
  commit('docs/getting-started', 'Update the repository setup guide');
  const head = commit('main', 'Make commit details easier to read');
  commit('feature/command-palette', 'Fine-tune search results and keyboard hints');
  return {
    commits: chronological.reverse(), head,
    refs: [
      { name: 'main', commitId: head, kind: 'local' },
      { name: 'feature/command-palette', commitId: tips.get('feature/command-palette')!, kind: 'local' },
      { name: 'docs/getting-started', commitId: tips.get('docs/getting-started')!, kind: 'local' },
      { name: 'fix/focus-ring', commitId: tips.get('fix/focus-ring')!, kind: 'local' },
      { name: 'origin/main', commitId: head, kind: 'remote' },
      { name: 'origin/feature/command-palette', commitId: tips.get('feature/command-palette')!, kind: 'remote' },
      { name: 'v0.8.0', commitId: release, kind: 'tag' },
      { name: 'v0.7.0', commitId: chronological[Math.min(153, chronological.length - 1)].id, kind: 'tag' },
    ],
  };
}

export const demoProvider: HistoryProvider = {
  kind: 'demo',
  async snapshot(repository) { return createDemoHistory(repository === 'gitty' ? 1 : repository === 'orbit-design' ? 7 : 13); },
};
