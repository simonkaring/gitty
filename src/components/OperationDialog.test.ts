import { describe, expect, it } from 'vitest';
import { linearRebaseRange } from './OperationDialog';
import type { CommitSummary } from '../model/repository';

const commit = (id: string, parents: string[]): CommitSummary => ({ id, parents, subject: id, author: 'Test', email: 'test@example.com', timestamp: 0 });

describe('interactive rebase range', () => {
  it('follows the checked-out parent chain despite interleaved graph branches', () => {
    const entries = [commit('top', ['second']), commit('side', ['base']), commit('second', ['first']), commit('first', ['base']), commit('base', [])];
    expect(linearRebaseRange('top', 'base', entries)?.map(value => value.id)).toEqual(['first', 'second', 'top']);
    expect(linearRebaseRange('top', 'side', entries)).toBeNull();
    expect(linearRebaseRange('top', 'first', entries)?.map(value => value.id)).toEqual(['second', 'top']);
  });

  it('does not offer an incomplete, merge-containing, or oversized plan', () => {
    expect(linearRebaseRange('top', 'base', [commit('top', ['a', 'b']), commit('base', [])])).toBeNull();
    expect(linearRebaseRange('top', 'base', [commit('top', ['unloaded']), commit('base', [])])).toBeNull();
    const entries = Array.from({ length: 102 }, (_, i) => commit(String(i), [String(i + 1)]));
    expect(linearRebaseRange('0', '101', entries)).toBeNull();
  });
});
