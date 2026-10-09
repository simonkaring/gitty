// @vitest-environment jsdom
import { act, useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RepositoryTabs } from './RepositoryTabs';
import { tabsReducer, type TabsState } from '../model/tabs';

const initial: TabsState = {
  tabs: ['a', 'b', 'c'].map(id => ({ id, title: id, location: null, key: null, busy: id === 'b', branch: null, dirty: false })),
  activeId: 'a', notice: null,
};
const select = vi.fn();
const move = vi.fn();
const close = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (id: string) => host.querySelector<HTMLButtonElement>(`#tab-${id}`)!;
const strip = () => host.querySelector<HTMLElement>('[role="tablist"]')!;
const order = () => [...host.querySelectorAll('[role="tab"]')].map(tab => tab.id);

function Harness() {
  const [state, dispatch] = useReducer(tabsReducer, initial);
  return <RepositoryTabs tabs={state.tabs} activeId={state.activeId} onSelect={id => { select(id); dispatch({ type: 'select', tabId: id }); }}
    onMove={(tabId, targetId) => { move(tabId, targetId); dispatch({ type: 'move', tabId, targetId }); }} onClose={close} onNew={() => {}} />;
}

async function pointer(target: Element, type: string, x: number, pointerId = 1, mouseButton = 0) {
  // jsdom has no native pointer capture or PointerEvent implementation.
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button: mouseButton });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  await act(async () => { target.dispatchEvent(event); });
}

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
  strip().setPointerCapture = vi.fn();
  strip().hasPointerCapture = vi.fn(() => true);
  strip().releasePointerCapture = vi.fn();
  for (const tab of host.querySelectorAll<HTMLButtonElement>('[role="tab"]')) tab.setPointerCapture = vi.fn();
  for (const tab of host.querySelectorAll<HTMLElement>('.repository-tab')) {
    tab.getBoundingClientRect = () => {
      const index = [...strip().children].indexOf(tab);
      return { left: index * 100, width: 100, right: (index + 1) * 100 } as DOMRect;
    };
  }
  strip().getBoundingClientRect = () => ({ left: 0, right: 300, width: 300 }) as DOMRect;
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

it('reorders across multiple tabs in both directions and preserves active selection', async () => {
  await pointer(button('b'), 'pointerdown', 120);
  await pointer(strip(), 'pointermove', 280);
  expect(order()).toEqual(['tab-a', 'tab-c', 'tab-b']);
  expect(button('b').parentElement?.dataset.dragging).toBe('true');
  // Transferring capture from the button to the stable strip must not cancel.
  await pointer(button('b'), 'lostpointercapture', 280);
  expect(button('b').parentElement?.dataset.dragging).toBe('true');
  // Staying at the same position does not bounce the moved tab back.
  await pointer(strip(), 'pointermove', 280);
  expect(move).toHaveBeenCalledTimes(1);
  await pointer(strip(), 'pointermove', 10);
  expect(order()).toEqual(['tab-b', 'tab-a', 'tab-c']);
  await pointer(strip(), 'pointerup', 10);
  await act(async () => { button('b').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
  expect(select).not.toHaveBeenCalled();
  expect(button('a').getAttribute('aria-selected')).toBe('true');
  expect(button('b').parentElement?.dataset.dragging).toBe('false');
  expect(strip().releasePointerCapture).toHaveBeenCalledWith(1);
});

it('keeps ordinary clicks and close buttons working without starting a drag', async () => {
  await pointer(button('c'), 'pointerdown', 220);
  await pointer(strip(), 'pointermove', 223);
  await pointer(strip(), 'pointerup', 223);
  await act(async () => { button('c').click(); });
  expect(select).toHaveBeenCalledWith('c');
  expect(move).not.toHaveBeenCalled();
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Close c"]')!.click(); });
  expect(close).toHaveBeenCalledWith('c');
});

it('ignores secondary buttons and unrelated pointers, and ends cancelled drags', async () => {
  await pointer(button('c'), 'pointerdown', 220, 1, 2);
  await pointer(strip(), 'pointermove', 10);
  expect(move).not.toHaveBeenCalled();
  await pointer(button('c'), 'pointerdown', 220);
  await pointer(strip(), 'pointermove', 10, 2);
  expect(move).not.toHaveBeenCalled();
  await pointer(strip(), 'pointermove', 10);
  await pointer(strip(), 'pointercancel', 10);
  expect(button('c').parentElement?.dataset.dragging).toBe('false');
  await pointer(strip(), 'pointermove', 280);
  expect(move).toHaveBeenCalledTimes(1);
  // A new gesture after cancellation behaves like an ordinary click.
  await pointer(button('b'), 'pointerdown', 220);
  await pointer(strip(), 'pointerup', 220);
  await act(async () => { button('b').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
  expect(select).toHaveBeenCalledWith('b');
});

it('moves a focused tab with Alt+arrows without wrapping or selecting another tab', async () => {
  const key = async (key: string) => act(async () => { button('a').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, altKey: true })); });
  await key('ArrowLeft');
  expect(move).not.toHaveBeenCalled();
  await key('ArrowRight');
  expect(order()).toEqual(['tab-b', 'tab-a', 'tab-c']);
  await key('ArrowLeft');
  expect(order()).toEqual(['tab-a', 'tab-b', 'tab-c']);
  expect(select).not.toHaveBeenCalled();
});

it('clears drag state when capture is lost so another gesture can start', async () => {
  await pointer(button('a'), 'pointerdown', 20);
  await pointer(button('a'), 'lostpointercapture', 20);
  await pointer(button('c'), 'pointerdown', 220);
  await pointer(strip(), 'pointermove', 10);
  expect(order()).toEqual(['tab-c', 'tab-a', 'tab-b']);
  await pointer(strip(), 'lostpointercapture', 10);
  expect(button('c').parentElement?.dataset.dragging).toBe('false');
  await pointer(strip(), 'pointermove', 280);
  expect(move).toHaveBeenCalledTimes(1);
});
