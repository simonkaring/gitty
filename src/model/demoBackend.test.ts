import { describe, expect, it } from 'vitest';
import { demoLocation } from './demoBackend';
import { native, readNativeSnapshot, setDemoMode } from './native';
import type { RepositoryState } from './repository';

describe('demo backend', () => {
  it('opens, stages, and commits through the native IPC helper', async () => {
    setDemoMode(true);
    const opened = await native<RepositoryState>('repository_open', { location: demoLocation('orbit-design') });
    const handle = opened.session.handle;
    const before = await readNativeSnapshot(handle);
    expect(before.commits.length).toBe(200);
    const staged = before.status.entries.filter(entry => entry.indexStatus !== '.').length;
    const unstaged = before.status.entries.filter(entry => entry.indexStatus === '.').map(entry => entry.path);
    await native('repository_stage', { handle, paths: unstaged });
    await native('repository_create_commit', { handle, message: 'Demo commit\n\nBody' });
    const after = await readNativeSnapshot(handle, { previous: before });
    expect(after.commits[0].subject).toBe('Demo commit');
    expect(after.commits[0].parents).toEqual([before.state.session.head]);
    expect(after.state.session.head).toBe(after.commits[0].id);
    expect(after.status.entries.filter(entry => entry.indexStatus !== '.').length).toBe(0);
    expect(staged + unstaged.length).toBeGreaterThan(0);
    await expect(native('repository_remote_action', { handle, action: { kind: 'push' } })).rejects.toMatchObject({ code: 'unsupported' });
    setDemoMode(false);
  });
});
