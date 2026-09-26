import { describe, expect, it } from 'vitest';
import { locationForPickedFolder, wslLocationFromWindowsPath } from './wslPath';

describe('WSL share paths', () => {
  it('maps wsl.localhost, wsl$ and long UNC forms to the distribution', () => {
    expect(wslLocationFromWindowsPath('\\\\wsl.localhost\\Ubuntu\\home\\sk\\code\\gitty')).toEqual({ kind: 'wsl', distribution: 'Ubuntu', path: '/home/sk/code/gitty' });
    expect(wslLocationFromWindowsPath('\\\\wsl$\\Debian\\srv\\repo with spaces\\')).toEqual({ kind: 'wsl', distribution: 'Debian', path: '/srv/repo with spaces' });
    expect(wslLocationFromWindowsPath('\\\\?\\UNC\\WSL.LOCALHOST\\Ubuntu-22.04\\tmp\\工作')).toEqual({ kind: 'wsl', distribution: 'Ubuntu-22.04', path: '/tmp/工作' });
    expect(wslLocationFromWindowsPath('//wsl.localhost/Ubuntu/home')).toEqual({ kind: 'wsl', distribution: 'Ubuntu', path: '/home' });
  });
  it('maps the distribution root', () => {
    expect(wslLocationFromWindowsPath('\\\\wsl.localhost\\Ubuntu')).toEqual({ kind: 'wsl', distribution: 'Ubuntu', path: '/' });
    expect(wslLocationFromWindowsPath('\\\\wsl.localhost\\Ubuntu\\')).toEqual({ kind: 'wsl', distribution: 'Ubuntu', path: '/' });
  });
  it('leaves other paths native', () => {
    expect(wslLocationFromWindowsPath('C:\\code\\gitty')).toBeNull();
    expect(wslLocationFromWindowsPath('\\\\server\\share\\repo')).toBeNull();
    expect(wslLocationFromWindowsPath('\\\\wsl.localhostx\\Ubuntu\\repo')).toBeNull();
    expect(locationForPickedFolder('/Users/dev/repo')).toEqual({ kind: 'native', path: '/Users/dev/repo' });
    expect(locationForPickedFolder('\\\\wsl$\\Ubuntu\\repo')).toEqual({ kind: 'wsl', distribution: 'Ubuntu', path: '/repo' });
  });
});
