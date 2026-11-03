// @vitest-environment jsdom
import { StrictMode, act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsProvider } from '../model/settings';
import { TABS_STORAGE_KEY } from '../model/tabs';
import { NativeWorkspace } from './NativeWorkspace';

type NativeLocation = { kind: 'native'; path: string };
interface ProbeProps { tabId: string; location: NativeLocation; active: boolean; onOpenWorktree: (location: NativeLocation) => void }

// RepositoryPane is replaced by a probe that "opens a session" on mount, so these tests
// assert exactly which restored tabs would have launched native work.
const mocks = vi.hoisted(() => ({
  opened: [] as string[],
  closed: [] as string[],
  panes: new Map<string, { onOpenWorktree: (location: { kind: 'native'; path: string }) => void }>(),
}));
vi.mock('./RepositoryPane', () => ({
  RepositoryPane: (props: ProbeProps) => {
    mocks.panes.set(props.tabId, props);
    useEffect(() => { mocks.opened.push(props.location.path); return () => { mocks.closed.push(props.location.path); }; }, [props.location.path]);
    return <div data-testid={`pane-${props.tabId}`} data-active={String(props.active)} />;
  },
}));

const tab = (id: string, path: string) => ({ id, location: { kind: 'native', path } });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, clear: () => store.clear() });
  mocks.opened.length = 0; mocks.closed.length = 0; mocks.panes.clear();
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function persist(tabs: ReturnType<typeof tab>[], activeId: string) { window.localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs, activeId })); }
const render = (strict = false) => act(async () => root.render(<SettingsProvider>{strict ? <StrictMode><NativeWorkspace demo={false} /></StrictMode> : <NativeWorkspace demo={false} />}</SettingsProvider>));
const tabButton = (id: string) => host.querySelector<HTMLElement>(`#tab-${id}`)!;
const pane = (id: string) => host.querySelector(`[data-testid="pane-${id}"]`);
const saved = () => JSON.parse(window.localStorage.getItem(TABS_STORAGE_KEY)!) as { tabs: { id: string }[]; activeId: string };

it('mounts only the active restored tab and keeps inactive tabs as labelled, panel-linked tabs', async () => {
  persist([tab('a', '/code/alpha'), tab('b', '/code/beta'), tab('c', '/code/gamma')], 'b');
  await render();
  expect(mocks.opened).toEqual(['/code/beta']);
  expect(pane('a')).toBeNull();
  expect(pane('c')).toBeNull();
  for (const [id, title] of [['a', 'alpha'], ['b', 'beta'], ['c', 'gamma']]) {
    expect(tabButton(id).textContent).toContain(title);
    const panel = host.querySelector<HTMLElement>(`#tabpanel-${id}`)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(`tab-${id}`);
    expect(panel.hidden).toBe(id !== 'b');
  }
});

it('does not open sessions for inactive tabs under StrictMode', async () => {
  persist([tab('a', '/code/alpha'), tab('b', '/code/beta')], 'a');
  await render(true);
  expect(new Set(mocks.opened)).toEqual(new Set(['/code/alpha']));
  expect(pane('b')).toBeNull();
});

it('mounts a tab on first selection and keeps it mounted after switching away', async () => {
  persist([tab('a', '/code/alpha'), tab('b', '/code/beta'), tab('c', '/code/gamma')], 'a');
  await render();
  await act(async () => tabButton('b').click());
  expect(mocks.opened).toEqual(['/code/alpha', '/code/beta']);
  expect(pane('b')!.getAttribute('data-active')).toBe('true');
  await act(async () => tabButton('a').click());
  expect(mocks.opened).toEqual(['/code/alpha', '/code/beta']);
  expect(mocks.closed).toEqual([]);
  expect(pane('b')!.getAttribute('data-active')).toBe('false');
  expect(pane('c')).toBeNull();
  await act(async () => tabButton('b').click());
  expect(mocks.opened).toEqual(['/code/alpha', '/code/beta']);
  expect(pane('b')!.getAttribute('data-active')).toBe('true');
});

it('reorders, closes and selects unloaded tabs from the keyboard, and persists them', async () => {
  persist([tab('a', '/code/alpha'), tab('b', '/code/beta'), tab('c', '/code/gamma')], 'a');
  await render();
  await act(async () => { tabButton('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })); });
  expect(saved().tabs.map(value => value.id)).toEqual(['b', 'a', 'c']);
  expect(mocks.opened).toEqual(['/code/alpha']);
  const close = tabButton('c').parentElement!.querySelector<HTMLElement>('button[aria-label^="Close"]')!;
  await act(async () => close.click());
  expect(saved().tabs.map(value => value.id)).toEqual(['b', 'a']);
  expect(mocks.opened).toEqual(['/code/alpha']);
  await act(async () => { tabButton('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
  expect(saved().activeId).toBe('b');
  expect(mocks.opened).toEqual(['/code/alpha', '/code/beta']);
});

it('focuses an unloaded tab instead of duplicating it when the same repository is opened again', async () => {
  persist([tab('a', '/code/alpha'), tab('b', '/code/beta')], 'a');
  await render();
  await act(async () => mocks.panes.get('a')!.onOpenWorktree({ kind: 'native', path: '/code/beta' }));
  expect(saved().tabs.map(value => value.id)).toEqual(['a', 'b']);
  expect(saved().activeId).toBe('b');
  expect(mocks.opened).toEqual(['/code/alpha', '/code/beta']);
  await act(async () => mocks.panes.get('b')!.onOpenWorktree({ kind: 'native', path: '/code/delta' }));
  expect(saved().tabs).toHaveLength(3);
  expect(mocks.opened).toEqual(['/code/alpha', '/code/beta', '/code/delta']);
});
