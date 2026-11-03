import type { PaletteCommand } from '../components/CommandPalette';

export type CommitGraphStatus = 'present' | 'missing' | 'disabled';
export const COMMIT_GRAPH_SLOW_MS = 300;
export function suggestCommitGraph(status: CommitGraphStatus | null, firstPageMs: number, dismissed: boolean) {
  return status === 'missing' && firstPageMs >= COMMIT_GRAPH_SLOW_MS && !dismissed;
}
const key = (repository: string) => `gitty:commit-graph-dismissed:${repository}`;
export function commitGraphDismissed(repository: string): boolean {
  try { return localStorage.getItem(key(repository)) === '1'; } catch { return false; }
}
export function dismissCommitGraph(repository: string) {
  try { localStorage.setItem(key(repository), '1'); } catch { /* Storage can be unavailable. */ }
}
export function commitGraphCommand(run: () => void, disabled: boolean): PaletteCommand {
  return { id: 'speed-up-history', label: 'Speed up history', group: 'Repository', disabled, run };
}
