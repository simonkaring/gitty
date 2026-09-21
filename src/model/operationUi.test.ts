import { describe, expect, it } from 'vitest';
import { acceptBlock, actionReason, conflictBlocks, editConflictText, moveCommit, toggleCommit } from './operationUi';
import type { OperationState } from './operations';
import type { RepositorySession } from './repository';

const session = { head: 'head', headRef: 'refs/heads/main', bare: false } as RepositorySession;
const idle: OperationState = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'idle' };
describe('operation eligibility and ordered selection', () => {
  it('uses explicit selection order without duplicates and supports reordering/removal', () => {
    let order = toggleCommit(toggleCommit([], 'newer'), 'older');
    expect(order).toEqual(['newer', 'older']);
    order = moveCommit(order, 1, -1);
    expect(order).toEqual(['older', 'newer']);
    expect(moveCommit(order, 0, -1)).toEqual(order);
    expect(toggleCommit(order, 'older')).toEqual(['newer']);
  });
  it('blocks detached merges, same-branch actions, unknown state and active operations', () => {
    const merge = { kind: 'merge' as const, source: 'refs/heads/topic', noFastForward: false };
    expect(actionReason(merge, session, idle)).toBe('');
    expect(actionReason(merge, { ...session, headRef: null }, idle)).toMatch(/Check out/);
    expect(actionReason({ ...merge, source: session.headRef! }, session, idle)).toMatch(/different/);
    expect(actionReason(merge, session, null)).toMatch(/unavailable/);
    expect(actionReason(merge, session, { ...idle, kind: 'rebase' })).toMatch(/Finish/);
    expect(actionReason({ kind: 'continue' }, session, { ...idle, kind: 'merge' })).toMatch(/Resolve/);
    expect(actionReason({ kind: 'abort' }, session, { ...idle, kind: 'merge' })).toBe('');
    expect(actionReason({ kind: 'skip' }, session, { ...idle, kind: 'merge' })).toMatch(/cannot skip/);
  });
});
describe('full-content conflict editing', () => {
  it('resolves diff3 blocks without changing surrounding bytes or CRLF', () => {
    const content = 'prefix\r\n<<<<<<< HEAD\r\nours\r\n||||||| base\r\nbase\r\n=======\r\ntheirs\r\n>>>>>>> topic\r\nno final newline';
    const [block] = conflictBlocks(content);
    expect(block.base).toBe('base\r\n');
    expect(acceptBlock(content, block, 'current')).toBe('prefix\r\nours\r\nno final newline');
    expect(acceptBlock(content, block, 'incoming')).toBe('prefix\r\ntheirs\r\nno final newline');
    expect(acceptBlock(content, block, 'both')).toBe('prefix\r\nours\r\ntheirs\r\nno final newline');
  });
  it('handles empty sides, custom marker widths, multiple blocks and missing final newline', () => {
    const one = '<<<<<<<<< ours\n=========\nincoming\n>>>>>>>>> theirs\n';
    const text = `${one}middle\n<<<<<<< current\ncurrent\n=======\n>>>>>>> incoming`;
    const blocks = conflictBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].current).toBe('');
    expect(blocks[1].incoming).toBe('');
    expect(acceptBlock(text, blocks[1], 'incoming')).toBe(`${one}middle\n`);
  });
  it('ignores incomplete markers and comparison-like text', () => {
    expect(conflictBlocks('<<<<<<< HEAD\nunfinished')).toEqual([]);
    expect(conflictBlocks('<<<<<<<not a marker\n=======\n>>>>>>>topic')).toEqual([]);
  });
  it('preserves mixed endings outside textarea edits, including an unchanged buffer', () => {
    const original = 'first\r\nsecond\nthird';
    expect(editConflictText(original, 'first\nsecond\nthird')).toBe(original);
    expect(editConflictText(original, 'first\nSECOND\nthird')).toBe('first\r\nSECOND\nthird');
    expect(editConflictText(original, 'first\nsecond\nthird\n')).toBe(`${original}\r\n`);
    expect(editConflictText('a\r\nb\r\n', 'a\nb')).toBe('a\r\nb');
  });
});
