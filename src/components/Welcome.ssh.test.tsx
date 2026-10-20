// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StartPage } from './Welcome';

const mocks = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock('../model/native', () => ({ native: mocks.native, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
vi.mock('../model/settings', () => ({ useSettings: () => ({ openSettings: vi.fn(), isSettingsOpen: false }) }));

let container: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.native.mockReset(); onOpen.mockReset();
  mocks.native.mockImplementation(async (command: string) => {
    if (command === 'repository_recent') return [{ kind: 'ssh', host: 'home', user: 'me', path: '/home/me/code/thing' }];
    if (command === 'wsl_distributions') return [];
    throw new Error(`Unexpected command ${command}`);
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function mount() {
  await act(async () => root.render(<StartPage onOpen={onOpen} onClone={() => {}} cloneBusy={false} />));
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
function input(label: string) {
  return [...container.querySelectorAll('input')].find(value => value.getAttribute('aria-label') === label || value.closest('label')?.textContent?.startsWith(label))!;
}
async function enter(label: string, value: string) {
  await act(async () => {
    const element = input(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('reopens an SSH repository from the recent list with its destination shown', async () => {
  await mount();
  expect(container.textContent).toContain('SSH · me@home');
  await click(container.querySelector<HTMLButtonElement>('.start-item')!.textContent!);
  expect(onOpen).toHaveBeenCalledWith({ kind: 'ssh', host: 'home', user: 'me', path: '/home/me/code/thing' });
});

it('tests the connection with the same validated destination it would open', async () => {
  mocks.native.mockImplementation(async (command: string) => {
    if (command === 'repository_recent' || command === 'wsl_distributions') return [];
    if (command === 'ssh_test') return { gitVersion: 'git version 2.44.0', name: 'thing' };
    throw new Error(`Unexpected command ${command}`);
  });
  await mount();
  await click('Open over SSH');
  await enter('Host', 'home.tailnet.ts.net');
  await enter('User (optional)', 'me');
  await enter('Port (optional)', '2222');
  await enter('Repository path', '/home/me/code/thing');
  await click('Test connection');
  expect(mocks.native).toHaveBeenCalledWith('ssh_test', { target: { host: 'home.tailnet.ts.net', user: 'me', port: 2222, path: '/home/me/code/thing' } });
  expect(container.textContent).toContain('git version 2.44.0');
  expect(container.textContent).toContain('thing is a Git repository');
  await click('Open repository');
  expect(onOpen).toHaveBeenCalledWith({ kind: 'ssh', host: 'home.tailnet.ts.net', user: 'me', port: 2222, path: '/home/me/code/thing' });
});

it('refuses a relative path or an option-like host before calling the backend', async () => {
  await mount();
  await click('Open over SSH');
  await enter('Host', '-oProxyCommand=evil');
  await enter('Repository path', 'code/thing');
  await click('Open repository');
  expect(onOpen).not.toHaveBeenCalled();
  expect(mocks.native).not.toHaveBeenCalledWith('ssh_test', expect.anything());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('SSH host alias');
});

it('explains an untrusted host key instead of retrying with a weaker policy', async () => {
  mocks.native.mockImplementation(async (command: string) => {
    if (command === 'repository_recent' || command === 'wsl_distributions') return [];
    if (command === 'ssh_test') throw { code: 'hostKeyUnknown', message: 'Host key verification failed.' };
    throw new Error(`Unexpected command ${command}`);
  });
  await mount();
  await click('Open over SSH');
  await enter('Host', 'home');
  await enter('Repository path', '/home/me/code/thing');
  await click('Test connection');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Connect once from a terminal');
  expect(onOpen).not.toHaveBeenCalled();
});

it('browses remote folders instead of requiring an exact path', async () => {
  mocks.native.mockImplementation(async (command: string, args?: { target?: { host: string; path: string } }) => {
    if (command === 'repository_recent' || command === 'wsl_distributions') return [];
    if (command === 'ssh_directories') {
      if (args?.target?.path === '/') return [{ name: 'home', path: '/home' }, { name: 'srv', path: '/srv' }];
      if (args?.target?.path === '/home') return [{ name: 'me', path: '/home/me' }];
      if (args?.target?.path === '/home/me') return [];
      throw { code: 'notFound', message: 'find: no such file or directory' };
    }
    throw new Error(`Unexpected command ${command}`);
  });
  await mount();
  await click('Open over SSH');
  await enter('Host', 'home');
  await click('Browse…');
  expect(mocks.native).toHaveBeenCalledWith('ssh_directories', { target: { host: 'home', user: undefined, port: undefined, path: '/' } });
  await chooseFolder('home');
  expect(input('Repository path').value).toBe('/home');
  await chooseFolder('me');
  expect(input('Repository path').value).toBe('/home/me');
  expect(container.textContent).toContain('No subfolders here');
  await click('Parent folder');
  expect(input('Repository path').value).toBe('/home');
  await click('Parent folder');
  expect(input('Repository path').value).toBe('/');
  await click('Use this folder');
  expect(container.querySelector('[aria-label="Remote folders"]')).toBeNull();
});

it('keeps browsing usable when a connection test overlaps a pending listing', async () => {
  let finishBrowse!: (folders: { name: string; path: string }[]) => void;
  let finishTest!: (probe: { gitVersion: string; name: string | null }) => void;
  mocks.native.mockImplementation((command: string) => {
    if (command === 'repository_recent' || command === 'wsl_distributions') return Promise.resolve([]);
    if (command === 'ssh_directories') return new Promise<{ name: string; path: string }[]>(resolve => { finishBrowse = resolve; });
    if (command === 'ssh_test') return new Promise<{ gitVersion: string; name: string | null }>(resolve => { finishTest = resolve; });
    return Promise.reject(new Error(`Unexpected command ${command}`));
  });
  await mount();
  await click('Open over SSH');
  await enter('Host', 'home');
  await enter('Repository path', '/home');
  await click('Browse…');
  // The test does not own the listing's busy flag, so it can start while it is pending.
  await click('Test connection');
  expect(mocks.native).toHaveBeenCalledWith('ssh_directories', { target: { host: 'home', user: undefined, port: undefined, path: '/home' } });
  expect(mocks.native).toHaveBeenCalledWith('ssh_test', { target: { host: 'home', user: undefined, port: undefined, path: '/home' } });

  await act(async () => { finishBrowse([{ name: 'me', path: '/home/me' }]); });
  // Browsing finished and released its own controls even though the test is pending.
  expect(button('Browse…')).toBeDefined();
  expect(container.querySelector('[aria-label="Remote folders"]')?.textContent).toContain('me');
  expect(input('Repository path').value).toBe('/home');

  await act(async () => { finishTest({ gitVersion: 'git version 2.44.0', name: 'thing' }); });
  expect(button('Test connection')).toBeDefined();
  expect(container.textContent).toContain('git version 2.44.0');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('discards a listing that arrives after the destination changed', async () => {
  let finishBrowse!: (folders: { name: string; path: string }[]) => void;
  mocks.native.mockImplementation((command: string) => {
    if (command === 'repository_recent' || command === 'wsl_distributions') return Promise.resolve([]);
    if (command === 'ssh_directories') return new Promise<{ name: string; path: string }[]>(resolve => { finishBrowse = resolve; });
    return Promise.reject(new Error(`Unexpected command ${command}`));
  });
  await mount();
  await click('Open over SSH');
  await enter('Host', 'home');
  await enter('Repository path', '/srv');
  await click('Browse…');
  await enter('Host', 'other');
  expect(button('Browse…')).toBeDefined();

  await act(async () => { finishBrowse([{ name: 'stale', path: '/stale' }]); });
  expect(container.querySelector('[aria-label="Remote folders"]')).toBeNull();
  expect(container.textContent).not.toContain('stale');
  expect(input('Repository path').value).toBe('/srv');
  expect(input('Host').value).toBe('other');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

function button(label: string) {
  return [...container.querySelectorAll('button')].find(value => value.textContent === label);
}

async function chooseFolder(name: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Remote folders"] button')].find(value => value.querySelector('strong')?.textContent === name);
  expect(button, name).toBeDefined();
  await act(async () => button!.click());
}
