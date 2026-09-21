import { diffLines } from './diff';
import type { DiffSpec, FileDiff, RepositoryStatus } from './repository';
import type { ChangedFile } from './types';

export interface DemoFile { path: string; head: string[] | null; index: string[] | null; working: string[] | null }
export const demoWorkingFiles = (): DemoFile[] => [
  { path: 'src/styles/tokens.css', head: [':root {', '  --row-height: 44px;', '  --accent: #7471c9;', '}'], index: [':root {', '  --row-height: 48px;', '  --accent: #7471c9;', '}'], working: [':root {', '  --row-height: 48px;', '  --accent: #21766c;', '}'] },
  { path: 'src/components/HistoryView.tsx', head: ['export const history = {', '  preserveSelection: false,', '  overscan: 4,', '};'], index: ['export const history = {', '  preserveSelection: false,', '  overscan: 4,', '};'], working: ['export const history = {', '  preserveSelection: true,', '  overscan: 12,', '};'] },
  { path: 'docs/workspace.md', head: null, index: null, working: ['# Your workspace', '', 'Explore history. Review changes. Compose a commit.'] },
];
const same = (a: string[] | null, b: string[] | null) => JSON.stringify(a) === JSON.stringify(b);
export function demoStatus(files: DemoFile[], head: string): RepositoryStatus {
  return { head, headRef: 'refs/heads/main', fingerprint: JSON.stringify(files), entries: files.filter(file => !same(file.head, file.index) || !same(file.index, file.working)).map(file => ({ path: file.path, oldPath: null, conflicted: false, untracked: file.head === null && file.index === null, indexStatus: same(file.head, file.index) ? '.' : file.head === null ? 'A' : file.index === null ? 'D' : 'M', worktreeStatus: same(file.index, file.working) ? '.' : file.working === null ? 'D' : 'M' })) };
}
export function demoFileDiff(files: DemoFile[], spec: DiffSpec, path: string): FileDiff {
  const file = files.find(file => file.path === path);
  if (!file) throw new Error('File no longer exists in this demo.');
  const before = spec.kind === 'staged' ? file.head : file.index;
  const after = spec.kind === 'staged' ? file.index : file.working;
  return { path, binary: false, truncated: false, message: 'Illustrative demo contents. No local files are modified.', hunks: [{ header: `@@ -1,${before?.length ?? 0} +1,${after?.length ?? 0} @@`, lines: diffLines(before ?? [], after ?? []).map(line => ({ kind: line.kind, content: line.text, oldLine: line.oldLine ?? null, newLine: line.newLine ?? null })) }] };
}
export function demoCommittedFiles(files: DemoFile[]): ChangedFile[] {
  return files.filter(file => !same(file.head, file.index)).map(file => ({ path: file.path, status: file.head === null ? 'added' : file.index === null ? 'deleted' : 'modified', before: file.head ?? [], after: file.index ?? [], additions: diffLines(file.head ?? [], file.index ?? []).filter(line => line.kind === 'add').length, deletions: diffLines(file.head ?? [], file.index ?? []).filter(line => line.kind === 'remove').length }));
}
