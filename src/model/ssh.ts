import type { RepositoryLocation } from './repository';

/** SSH repositories: a working tree on another machine, reached with the user's own
 * `ssh` configuration. The backend validates everything again; these checks exist to
 * explain a mistake before a round trip, not to be the security boundary. */
export type SshLocation = Extract<RepositoryLocation, { kind: 'ssh' }>;

export const isSshLocation = (location: RepositoryLocation): location is SshLocation => location.kind === 'ssh';

/** `you@home:2222` — the destination part, without a path. */
export function sshDestination(location: SshLocation): string {
  const user = location.user ? `${location.user}@` : '';
  const port = location.port ? `:${location.port}` : '';
  return `${user}${location.host}${port}`;
}

/** `you@home:~/code/thing`-style label for recents and the sidebar. */
export function sshDisplayPath(location: SshLocation): string {
  return `${sshDestination(location)}:${location.path}`;
}

/** Identity of the host, independent of the repository path. Drafts and commit
 * profiles are per repository, so this is always combined with the resolved root. */
export function locationIdentity(location: RepositoryLocation): string {
  if (location.kind === 'wsl') return `wsl:${location.distribution}`;
  if (location.kind === 'ssh') return `ssh:${location.user ?? ''}@${location.host}:${location.port ?? ''}`;
  return 'native';
}

export interface SshProbe { gitVersion: string; name: string | null }

/** Mirrors the backend's accepted host and user characters. */
export function validSshWord(value: string): boolean {
  return value.length > 0 && value.length <= 253 && !value.startsWith('-') && /^[A-Za-z0-9._-]+$/.test(value);
}

/** Absolute POSIX paths only: a quoted `~` or a relative path would reach Git
 * literally and fail on the remote. */
export function validSshPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(path) && !path.split('/').includes('..');
}

/** Validates the connect form and returns the location to open, or a readable reason. */
export function sshLocationFromForm(form: { host: string; user: string; port: string; path: string }): SshLocation | string {
  const host = form.host.trim();
  const user = form.user.trim();
  const path = form.path.trim();
  const port = form.port.trim();
  if (!validSshWord(host)) return 'Enter an SSH host alias or hostname (letters, digits, dots, dashes or underscores).';
  if (user && !validSshWord(user)) return 'Enter an SSH user name using letters, digits, dots, dashes or underscores.';
  if (port && (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return 'Enter a port between 1 and 65535, or leave it empty.';
  if (!validSshPath(path)) return 'Enter the absolute path of the repository on that machine, for example /home/you/code/thing.';
  return { kind: 'ssh', host, user: user || undefined, port: port ? Number(port) : undefined, path };
}

/** Human-readable explanation for a failed connection test. The backend already
 * names the host and key in its message, so this only adds the fix. */
export function sshFailureHint(code: string): string {
  switch (code) {
    case 'hostKeyUnknown': return 'Connect once from a terminal so its host key is trusted; Gitty never accepts a key for you.';
    case 'authRequired': return 'Set up key-based authentication or ~/.ssh/config for this host; Gitty cannot answer a password prompt.';
    case 'connectFailed': return 'Check that the host is awake and reachable, for example over Tailscale.';
    case 'notARepository': return 'That path is missing or is not a Git repository.';
    case 'gitMissing': return 'Install Git on that machine and check that ssh runs with it on PATH.';
    default: return '';
  }
}
