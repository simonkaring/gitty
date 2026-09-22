import { describe, expect, it } from 'vitest';
import { cloneReducer, suggestedCloneName, type CloneRequest } from './clone';

const request: CloneRequest = { source: 'https://example.test/team/repo.git', parent: { kind: 'native', path: '/work' }, directoryName: 'repo' };

describe('clone operation state', () => {
  it('keeps progress and cancellation bound to the operation that started them', () => {
    let state = cloneReducer({ status: 'idle' }, { type: 'start', operationId: 'one', request });
    state = cloneReducer(state, { type: 'progress', operationId: 'other', progress: { phase: 'wrong', percent: 1, message: 'wrong' } });
    expect(state).toMatchObject({ status: 'running', progress: null });
    state = cloneReducer(state, { type: 'progress', operationId: 'one', progress: { phase: 'receiving objects', percent: 42, message: 'Receiving objects: 42%' } });
    expect(state).toMatchObject({ status: 'running', progress: { percent: 42 } });
    state = cloneReducer(state, { type: 'cancel', operationId: 'one' });
    expect(state.status).toBe('cancelling');
    state = cloneReducer(state, { type: 'cancelRejected', operationId: 'one' });
    expect(state).toMatchObject({ status: 'running', progress: { percent: 42 } });
    state = cloneReducer(state, { type: 'cancel', operationId: 'one' });
    expect(cloneReducer(state, { type: 'finish', operationId: 'one' })).toEqual({ status: 'idle' });
  });

  it('retains actionable failure text until dismissed', () => {
    const running = cloneReducer({ status: 'idle' }, { type: 'start', operationId: 'one', request });
    const failed = cloneReducer(running, { type: 'fail', operationId: 'one', message: 'Authentication failed' });
    expect(failed).toEqual({ status: 'error', message: 'Authentication failed' });
    expect(cloneReducer(failed, { type: 'dismiss' })).toEqual({ status: 'idle' });
  });
});

describe('clone destination suggestion', () => {
  it.each([
    ['https://example.test/team/repo.git', 'repo'],
    ['git@example.test:team/repo.git', 'repo'],
    ['/tmp/local repository/', 'local repository'],
    ['', 'repository'],
  ])('derives %s as %s', (source, expected) => expect(suggestedCloneName(source)).toBe(expected));
});
