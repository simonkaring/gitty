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
    const summary = summarizeArgs(raw);
    expect(summary).not.toContain('ghp_secret123');
    expect(summary).not.toContain('super-secret-password');
    expect(summary).not.toContain('creds');
    expect(summary).toContain('[redacted]');
    expect(summary).toContain('hello');
  });

  it('strips credentials from URLs in arguments and errors', () => {
    const summary = summarizeArgs({ request: { source: 'https://user:p@ss@example.com/repo.git?access_token=abc#frag', directoryName: 'repo' } });
    expect(summary).toBe('{"request":{"source":"https://[redacted]@example.com/repo.git?[redacted]","directoryName":"repo"}}');
    expect(scrubUrls('fatal: unable to access https://u:secret@host/x.git/: 403')).toBe('fatal: unable to access https://[redacted]@host/x.git/: 403');
    clearActivityLog();
    recordCommandEnd(recordCommandStart('repository_clone', {}), 'error', 1, 'fatal: https://u:secret@host/x.git failed');
    expect(getActivityLog()[0].error).not.toContain('secret');
  });

  it('safely handles circular or unserializable arguments', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(summarizeArgs(circular)).toBe('[unserializable]');

    const withBigInt = { num: BigInt(9007199254740991) };
    expect(summarizeArgs(withBigInt)).toBe('[unserializable]');
  });

  it('keeps long arguments whole up to a large bound, then says what was dropped', () => {
    expect(summarizeArgs({ data: 'a'.repeat(5000) })).toHaveLength('{"data":""}'.length + 5000);
    const summary = summarizeArgs({ data: 'a'.repeat(100_000) });
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
});
