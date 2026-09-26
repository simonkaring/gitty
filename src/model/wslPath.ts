import type { RepositoryLocation } from './repository';

// Windows exposes WSL files as `\\wsl.localhost\<distribution>\...` (or the
// older `\\wsl$\...`), sometimes in the `\\?\UNC\` long-path form. Git must run
// inside the distribution rather than as Windows Git over that share.
const UNC = /^(?:\\\\\?\\UNC\\|\\\\|\/\/)(?:wsl\$|wsl\.localhost)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i;

/** The WSL location for a Windows WSL share path, or null for any other path. */
export function wslLocationFromWindowsPath(path: string): Extract<RepositoryLocation, { kind: 'wsl' }> | null {
  const match = UNC.exec(path.trim());
  if (!match) return null;
  const segments = (match[2] ?? '').split(/[\\/]+/).filter(Boolean);
  return { kind: 'wsl', distribution: match[1], path: `/${segments.join('/')}` };
}

/** Routes a folder chosen in the Windows picker to the transport that owns it. */
export function locationForPickedFolder(path: string): RepositoryLocation {
  return wslLocationFromWindowsPath(path) ?? { kind: 'native', path };
}
