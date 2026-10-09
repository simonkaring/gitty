// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearActivityLog, getActivityLog, recordCommandEnd, recordCommandStart } from './activity';
import { isCancelledSearch } from './searchFlow';
import { demoLocation } from './demoBackend';
import { native, setDemoMode } from './native';
import type { RepositoryState } from './repository';

const invoke = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('search cancellation contract', () => {
  beforeEach(() => { clearActivityLog(); invoke.mockReset(); setDemoMode(false); });

  it('recognises only the backend cancelled rejection', () => {
    expect(isCancelledSearch({ code: 'cancelled', message: 'Search cancelled.' })).toBe(true);
    expect(isCancelledSearch({ code: 'git_failed', message: 'x' })).toBe(false);
    expect(isCancelledSearch(new Error('cancelled'))).toBe(false);
    expect(isCancelledSearch(null)).toBe(false);
    expect(isCancelledSearch('cancelled')).toBe(false);
  });

  it('does not log a cancelled search as an error but still logs real search failures', async () => {
    invoke.mockRejectedValueOnce({ code: 'cancelled', message: 'Search cancelled.' });
    await expect(native('repository_search', { handle: 'h', query: { text: 'a' } })).rejects.toMatchObject({ code: 'cancelled' });
    expect(getActivityLog()).toHaveLength(0);
    invoke.mockRejectedValueOnce({ code: 'git_failed', message: 'boom' });
    await expect(native('repository_search', { handle: 'h', query: { text: 'a' } })).rejects.toMatchObject({ code: 'git_failed' });
    expect(getActivityLog()).toEqual([expect.objectContaining({ command: 'repository_search', status: 'error', error: 'boom' })]);
  });

  it('treats repository_cancel_search as a quiet command and a no-op in the demo backend', async () => {
    recordCommandEnd(recordCommandStart('repository_cancel_search', { handle: 'h' }), 'success', 1);
    expect(getActivityLog()).toHaveLength(0);
    setDemoMode(true);
    const opened = await native<RepositoryState>('repository_open', { location: demoLocation('orbit-design') });
    await expect(native('repository_cancel_search', { handle: opened.session.handle })).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    setDemoMode(false);
  });
});
