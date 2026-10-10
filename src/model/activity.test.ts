import { describe, expect, it } from 'vitest';
import {
  clearActivityLog,
  getActivityLog,
  recordCommandEnd,
  recordCommandStart,
  recordGitCommand,
  scrubUrls,
  summarizeArgs,
} from './activity';

describe('activity log', () => {
  it('records mutation command start, completion, and duration under the real command name', () => {
    clearActivityLog();
    const id = recordCommandStart('repository_stage', { paths: ['file.txt'] });
    let entries = getActivityLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id,
      command: 'repository_stage',
      args: '{"paths":["file.txt"]}',
      status: 'running',
    });

    recordCommandEnd(id, 'success', 42.4);
    entries = getActivityLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('success');
    expect(entries[0].durationMs).toBe(42);
  });

  it('omits successful routine reads but keeps their failures', () => {
    clearActivityLog();
    for (const command of ['repository_status', 'repository_diff', 'app_start_dragging', 'provider_oauth_poll']) {
      recordCommandEnd(recordCommandStart(command, { handle: 'h' }), 'success', 10);
    }
    expect(getActivityLog()).toHaveLength(0);

    const id = recordCommandStart('repository_status', { handle: 'h' });
    recordCommandEnd(id, 'error', 12.2, 'Repository not found');
    expect(getActivityLog()).toEqual([expect.objectContaining({ id, command: 'repository_status', status: 'error', durationMs: 12, error: 'Repository not found' })]);
  });

  it('keeps mutations and background fetches', () => {
    clearActivityLog();
    recordCommandEnd(recordCommandStart('repository_remote_action', { action: { kind: 'backgroundFetch', remote: 'origin' } }), 'success', 30);
    expect(getActivityLog().map(e => e.command)).toEqual(['repository_remote_action']);
  });

  it('records git commands reported by the backend', () => {
    clearActivityLog();
    recordGitCommand({ command: 'git fetch -- origin refs/heads/*:refs/remotes/origin/*', stdin: null, success: true, code: 0, millis: 800 });
    recordGitCommand({ command: 'git push -- https://u:secret@host/x.git main', stdin: null, success: false, code: 1, millis: 50 });
    const [fetch, push] = getActivityLog();
    expect(fetch).toMatchObject({ command: 'git fetch -- origin refs/heads/*:refs/remotes/origin/*', status: 'success', durationMs: 800 });
    expect(push).toMatchObject({ status: 'error', error: 'Git exited with code 1' });
    expect(push.command).not.toContain('secret');
    expect(fetch.stdin).toBeUndefined();
  });

  it('keeps stdin paths and commit messages whole', () => {
    clearActivityLog();
    const message = 'feat: add stuff\n\n' + 'body line\n'.repeat(50);
    recordGitCommand({ command: 'git commit --quiet --file=-', stdin: message, success: true, code: 0, millis: 9 });
    recordGitCommand({ command: 'git add --all --pathspec-from-file=-', stdin: 'src/a b.ts\nsrc/c.ts', success: true, code: 0, millis: 3 });
    const [commit, add] = getActivityLog();
    expect(commit.stdin).toBe(message);
    expect(add.stdin).toBe('src/a b.ts\nsrc/c.ts');
  });

  it('records failure error message', () => {
    clearActivityLog();
    const id = recordCommandStart('repository_create_commit', { message: 'feat: test' });
    recordCommandEnd(id, 'error', 15.1, 'Hook failed');
    const entries = getActivityLog();
    expect(entries[0].command).toBe('repository_create_commit');
    expect(entries[0].status).toBe('error');
    expect(entries[0].error).toBe('Hook failed');
  });

  it('redacts sensitive fields in summarizeArgs', () => {
    const raw = {
      token: 'ghp_secret123',
      nested: {
        password: 'super-secret-password',
        safeField: 'hello',
        userCredential: 'creds',
      },
    };
    const summary = summarizeArgs('repository_test', raw);
    expect(summary).not.toContain('ghp_secret123');
    expect(summary).not.toContain('super-secret-password');
    expect(summary).not.toContain('creds');
    expect(summary).toContain('[redacted]');
    expect(summary).toContain('hello');
  });

  it('strips credentials from URLs in arguments and errors', () => {
    const summary = summarizeArgs('repository_test', { request: { source: 'https://user:p@ss@example.com/repo.git?access_token=abc#frag', directoryName: 'repo' } });
    expect(summary).toBe('{"request":{"source":"https://[redacted]@example.com/repo.git?[redacted]","directoryName":"repo"}}');
    expect(scrubUrls('fatal: unable to access https://u:secret@host/x.git/: 403')).toBe('fatal: unable to access https://[redacted]@host/x.git/: 403');
    clearActivityLog();
    recordCommandEnd(recordCommandStart('repository_clone', {}), 'error', 1, 'fatal: https://u:secret@host/x.git failed');
    expect(getActivityLog()[0].error).not.toContain('secret');
  });

  it('safely handles circular or unserializable arguments', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(summarizeArgs('repository_test', circular)).toBe('[unserializable]');

    const withBigInt = { num: BigInt(9007199254740991) };
    expect(summarizeArgs('repository_test', withBigInt)).toBe('[unserializable]');
  });

  it('keeps long arguments whole up to a large bound, then says what was dropped', () => {
    expect(summarizeArgs('repository_test', { data: 'a'.repeat(5000) })).toHaveLength('{"data":""}'.length + 5000);
    const summary = summarizeArgs('repository_test', { data: 'a'.repeat(100_000) });
    expect(summary).toMatch(/more characters not kept\]$/);
    expect(summary.length).toBeLessThan(65_700);
  });

  it('caps buffer to maximum entries and safely handles ending evicted entries', () => {
    clearActivityLog();
    // Simulate capping
    for (let i = 0; i < 2010; i++) {
      recordCommandStart(`cmd_${i}`);
    }
    const entries = getActivityLog();
    expect(entries).toHaveLength(2000);
    expect(entries[0].command).toBe('cmd_10');
    expect(entries[entries.length - 1].command).toBe('cmd_2009');

    // Ending an evicted id (e.g. id = 1) should be a safe no-op
    expect(() => recordCommandEnd(1, 'success', 10)).not.toThrow();
  });

  it('never retains resolved conflict text, only its size', () => {
    clearActivityLog();
    const secretText = 'API_KEY=hunter2\nüñí';
    const args = { handle: 'h1', path: 'src/a.ts', fingerprint: 'fp1', resolution: { kind: 'text', content: secretText } };
    recordCommandEnd(recordCommandStart('repository_resolve_conflict', args), 'success', 1);
    const [entry] = getActivityLog();
    expect(JSON.stringify(getActivityLog())).not.toContain('hunter2');
    expect(JSON.parse(entry.args)).toEqual({ handle: 'h1', path: 'src/a.ts', fingerprint: 'fp1', resolution: { kind: 'text', contentBytes: new TextEncoder().encode(secretText).length } });
    // Non-text resolutions keep only their kind.
    expect(summarizeArgs('repository_resolve_conflict', { path: 'a', fingerprint: 'f', resolution: { kind: 'ours' } })).toBe('{"path":"a","fingerprint":"f","resolution":{"kind":"ours"}}');
  });

  it('omits any content key generically', () => {
    const summary = summarizeArgs('repository_other', { nested: { content: 'top secret body' }, list: [{ content: 'also secret' }], content: 42 });
    expect(summary).not.toContain('secret');
    expect(JSON.parse(summary)).toEqual({ nested: { content: { bytes: 15 } }, list: [{ content: { bytes: 11 } }], content: '[content omitted]' });
  });

  it('clips very long errors', () => {
    clearActivityLog();
    recordCommandEnd(recordCommandStart('repository_push', {}), 'error', 1, 'e'.repeat(200_000));
    const error = getActivityLog()[0].error!;
    expect(error.length).toBeLessThan(65_700);
    expect(error).toMatch(/more characters not kept\]$/);
  });

  it('evicts oldest entries beyond the total byte budget', () => {
    clearActivityLog();
    for (let i = 0; i < 120; i++) recordCommandStart(`cmd_${i}`, { data: 'x'.repeat(60_000) });
    const entries = getActivityLog();
    expect(entries.length).toBeLessThan(120);
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.reduce((n, e) => n + e.command.length + e.args.length, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(entries[entries.length - 1].command).toBe('cmd_119');
    expect(entries.some(e => e.command === 'cmd_0')).toBe(false);
    clearActivityLog();
  });
});
