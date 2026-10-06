import type { GitAction, OperationState } from './operations';
import type { RepositorySession } from './repository';

export function actionReason(action: GitAction, session: RepositorySession, operation: OperationState | null): string {
  if (!operation) return 'Operation state is unavailable. Refresh first.';
  if (session.bare) return 'Working-tree operations require a non-bare repository.';
  if (action.kind === 'continue' || action.kind === 'skip' || action.kind === 'abort') {
    if (operation.kind === 'none') return 'No operation is in progress.';
    if (operation.kind === 'unsupported') return 'This operation must be completed in a terminal.';
    if (action.kind === 'continue' && !operation.canContinue) return 'Resolve and mark all conflicts before continuing.';
    if (action.kind === 'skip' && !operation.canSkip) return 'This operation cannot skip a step.';
    return '';
  }
  if (operation.kind !== 'none') return 'Finish or abort the current operation first.';
  if (action.kind === 'createBranch') return action.name.trim() && action.startPoint ? '' : 'Enter a branch name and starting revision.';
  if (action.kind === 'switchBranch') return action.branch && action.branch !== session.headRef && action.branch !== session.headRef?.replace(/^refs\/heads\//, '') ? '' : 'Choose a different local branch.';
  if (!session.head) return 'This operation needs an existing HEAD commit.';
  if (action.kind === 'createTag') return action.name.trim() && action.oid ? '' : 'Enter a tag name and commit.';
  if (action.kind === 'cherryPick') return action.commits.length ? '' : 'Choose commits in the order they should be applied.';
  if (!session.headRef) return 'Check out a local branch first.';
  const source = action.kind === 'merge' ? action.source : action.kind === 'rebase' || action.kind === 'interactiveRebase' ? action.onto : '';
  const destination = action.kind === 'merge' ? action.destination ?? session.headRef : session.headRef;
  return source && source !== destination && source !== destination?.replace(/^refs\/heads\//, '') ? '' : 'Choose a source different from the destination branch.';
}

/** Selection order is explicit; never infer application order from graph lanes. */
export function toggleCommit(order: string[], oid: string): string[] {
  return order.includes(oid) ? order.filter(value => value !== oid) : [...order, oid];
}
export function moveCommit<T>(order: T[], index: number, delta: number): T[] {
  const next = [...order], destination = index + delta;
  if (index < 0 || index >= order.length || destination < 0 || destination >= order.length) return next;
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}

export interface ConflictBlock { start: number; end: number; current: string; incoming: string; base: string | null }
/** Offsets and payloads retain CRLF and the absence of a terminal newline. */
export function conflictBlocks(text: string): ConflictBlock[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const blocks: ConflictBlock[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const start = offset;
    const opening = /^(<{7,})(?: |\r?\n|$)/.exec(lines[i]);
    if (!opening) { offset += lines[i].length; continue; }
    const width = opening[1].length;
    let separator = -1, ancestor = -1, end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (new RegExp(`^<{${width}}(?: |\\r?\\n|$)`).test(lines[j])) break;
      if (new RegExp(`^\\|{${width}}(?: |\\r?\\n|$)`).test(lines[j])) ancestor = j;
      if (new RegExp(`^={${width}}\\r?(?:\\n|$)`).test(lines[j])) separator = j;
      if (new RegExp(`^>{${width}}(?: |\\r?\\n|$)`).test(lines[j])) { end = j; break; }
    }
    if (separator < 0 || end <= separator || (ancestor >= 0 && ancestor >= separator)) { offset += lines[i].length; continue; }
    const length = lines.slice(i, end + 1).join('').length;
    blocks.push({ start, end: start + length, current: lines.slice(i + 1, ancestor < 0 ? separator : ancestor).join(''), base: ancestor < 0 ? null : lines.slice(ancestor + 1, separator).join(''), incoming: lines.slice(separator + 1, end).join('') });
    offset += length; i = end;
  }
  return blocks;
}
export function acceptBlock(text: string, block: ConflictBlock, choice: 'current' | 'incoming' | 'both'): string {
  return text.slice(0, block.start) + (choice === 'both' ? block.current + block.incoming : block[choice]) + text.slice(block.end);
}

/** Textareas normalize CRLF. Splice only the edited interval into the original
 * buffer, retaining untouched mixed line endings and final-newline state. */
export function editConflictText(original: string, edited: string): string {
  const normalized = original.replace(/\r\n?/g, '\n');
  if (normalized === edited) return original;
  let start = 0, end = normalized.length, newEnd = edited.length;
  while (start < end && start < newEnd && normalized[start] === edited[start]) start++;
  while (end > start && newEnd > start && normalized[end - 1] === edited[newEnd - 1]) { end--; newEnd--; }
  const offsets = [0];
  for (let i = 0; i < original.length; i++) { if (original[i] === '\r' && original[i + 1] === '\n') i++; offsets.push(i + 1); }
  const newline = original.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  return original.slice(0, offsets[start]) + edited.slice(start, newEnd).replace(/\n/g, newline) + original.slice(offsets[end]);
}
