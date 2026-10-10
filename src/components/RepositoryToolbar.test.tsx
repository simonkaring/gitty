// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RepositoryToolbar } from './RepositoryToolbar';

const mocks = vi.hoisted(() => ({ native: vi.fn<(...args: unknown[]) => Promise<unknown>>() }));
vi.mock('../model/native', () => ({ native: mocks.native, errorMessage: String }));

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.native.mockReset().mockResolvedValue({ branch: 'main', upstream: null, ahead: 0, behind: 0, remotes: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<RepositoryToolbar handle="repo" active revision={0} busy={false} pickCount={1} pickMode onCreateBranch={() => {}} onSwitchBranch={() => {}} onCherryPick={() => {}} onClearPick={() => {}} onStartPickMode={() => {}} onOpenStash={() => {}} onRefresh={() => {}} onWrite={async () => ''} notify={() => {}} />);
  });
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const key = (name: string) => act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); });
const items = () => [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')];

it('focuses the first pull-menu item on open and moves with arrows, Home and End', async () => {
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="More pull options"]')!;
  await act(async () => { toggle.click(); });
  const menu = items();
  expect(menu.length).toBeGreaterThan(2);
  expect(document.activeElement).toBe(menu[0]);
  await key('ArrowDown');
  expect(document.activeElement).toBe(menu[1]);
  await key('End');
  expect(document.activeElement).toBe(menu[menu.length - 1]);
  await key('ArrowDown');
  expect(document.activeElement).toBe(menu[0]);
  await key('ArrowUp');
  expect(document.activeElement).toBe(menu[menu.length - 1]);
  await key('Home');
  expect(document.activeElement).toBe(menu[0]);
});

it('skips disabled branch-menu items and closes on Escape returning focus to the toggle, or on Tab', async () => {
  const toggle = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Branch')!;
  await act(async () => { toggle.click(); });
  const enabled = items().filter(item => !(item as HTMLButtonElement).disabled);
  expect(document.activeElement).toBe(enabled[0]);
  await key('End');
  expect(document.activeElement).toBe(enabled[enabled.length - 1]);
  await key('Escape');
  expect(items()).toHaveLength(0);
  expect(document.activeElement).toBe(toggle);
  await act(async () => { toggle.click(); });
  expect(items().length).toBeGreaterThan(0);
  await key('Tab');
  expect(items()).toHaveLength(0);
});
