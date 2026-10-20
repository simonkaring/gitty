import { describe, expect, it } from 'vitest';
import { locationIdentity, repositoryStorageKey, sshDestination, sshDisplayPath, sshFailureHint, sshLocationFromForm, validSshPath, validSshWord } from './ssh';

const form = { host: ' home ', user: '', port: '', path: '/home/me/code/thing' };

describe('SSH connect form', () => {
  it('trims the destination and omits empty optional fields', () => {
    expect(sshLocationFromForm(form)).toEqual({ kind: 'ssh', host: 'home', user: undefined, port: undefined, path: '/home/me/code/thing' });
    expect(sshLocationFromForm({ ...form, user: 'me', port: '2222' })).toEqual({ kind: 'ssh', host: 'home', user: 'me', port: 2222, path: '/home/me/code/thing' });
  });
  it('refuses values that could change how ssh parses the destination', () => {
    for (const host of ['', '-oProxyCommand=touch x', 'home me', 'home;rm -rf /', 'user@host']) {
      expect(typeof sshLocationFromForm({ ...form, host }), host).toBe('string');
    }
    for (const user of ['-lroot', 'two words']) {
      expect(typeof sshLocationFromForm({ ...form, user }), user).toBe('string');
    }
    for (const port of ['0', '70000', 'ssh']) {
      expect(typeof sshLocationFromForm({ ...form, port }), port).toBe('string');
    }
  });
  it('accepts only absolute POSIX paths without parent segments', () => {
    expect(validSshPath('/srv/repo')).toBe(true);
    expect(validSshPath("/tmp/a b's")).toBe(true);
    for (const path of ['', 'relative', '~/repo', '/tmp/../etc', '/tmp/a\nb']) expect(validSshPath(path), path).toBe(false);
    expect(typeof sshLocationFromForm({ ...form, path: '~/repo' })).toBe('string');
  });
  it('accepts host aliases, tailnet names and bracketed characters that ssh understands', () => {
    for (const host of ['home', 'home.tailnet.ts.net', '10.0.0.5', 'my_host']) expect(validSshWord(host), host).toBe(true);
  });
});

describe('SSH destinations', () => {
  it('renders the destination with and without optional parts', () => {
    expect(sshDestination({ kind: 'ssh', host: 'home', path: '/r' })).toBe('home');
    expect(sshDestination({ kind: 'ssh', host: 'home', user: 'me', port: 2222, path: '/r' })).toBe('me@home:2222');
    expect(sshDisplayPath({ kind: 'ssh', host: 'home', user: 'me', path: '/r' })).toBe('me@home:/r');
  });
  it('keys the host identity separately from the repository path', () => {
    expect(locationIdentity({ kind: 'ssh', host: 'home', user: 'me', path: '/a' })).toBe(locationIdentity({ kind: 'ssh', host: 'home', user: 'me', path: '/b' }));
    expect(locationIdentity({ kind: 'ssh', host: 'home', path: '/a' })).not.toBe(locationIdentity({ kind: 'native', path: '/a' }));
  });
  it('keeps the stored-identity payload earlier releases wrote for native and WSL', () => {
    expect(repositoryStorageKey({ kind: 'native', path: '/repo' }, '/repo')).toBe('["native","","/repo"]');
    expect(repositoryStorageKey({ kind: 'wsl', distribution: 'Ubuntu', path: '/repo' }, '/repo')).toBe('["wsl","Ubuntu","/repo"]');
    const ssh = repositoryStorageKey({ kind: 'ssh', host: 'home', user: 'me', port: 2222, path: '/repo' }, '/repo');
    expect(ssh).toBe('["ssh:me@home:2222","/repo"]');
    expect(ssh).not.toBe(repositoryStorageKey({ kind: 'ssh', host: 'other', user: 'me', path: '/repo' }, '/repo'));
  });
  it('explains each connection failure with a fix', () => {
    expect(sshFailureHint('hostKeyUnknown')).toContain('host key');
    expect(sshFailureHint('authRequired')).toContain('password');
    expect(sshFailureHint('connectFailed')).toContain('SSH server');
    expect(sshFailureHint('posixShellRequired')).toContain('WSL');
    expect(sshFailureHint('notARepository')).toContain('Git repository');
    expect(sshFailureHint('whatever')).toBe('');
  });
});
