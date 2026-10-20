import { expect, it } from 'vitest';
import { NARROW_PANE_MAX_WIDTH, setPaneOpen, settleSidePanes } from './paneLayout';

it('opens panes independently on wide windows', () => {
  expect(setPaneOpen({ sidebar: false, inspector: false }, 'sidebar', true, false)).toEqual({ sidebar: true, inspector: false });
  expect(setPaneOpen({ sidebar: true, inspector: false }, 'inspector', true, false)).toEqual({ sidebar: true, inspector: true });
});

it('closes only the named pane', () => {
  expect(setPaneOpen({ sidebar: true, inspector: true }, 'inspector', false, false)).toEqual({ sidebar: true, inspector: false });
  expect(setPaneOpen({ sidebar: true, inspector: true }, 'sidebar', false, true)).toEqual({ sidebar: false, inspector: true });
});

it('keeps one side pane open on narrow windows', () => {
  expect(setPaneOpen({ sidebar: true, inspector: false }, 'inspector', true, true)).toEqual({ sidebar: false, inspector: true });
  expect(setPaneOpen({ sidebar: false, inspector: true }, 'sidebar', true, true)).toEqual({ sidebar: true, inspector: false });
  expect(setPaneOpen({ sidebar: false, inspector: false }, 'sidebar', true, true)).toEqual({ sidebar: true, inspector: false });
});

it('settles both-open state when the window narrows', () => {
  expect(settleSidePanes({ sidebar: true, inspector: true }, true)).toEqual({ sidebar: true, inspector: false });
  expect(settleSidePanes({ sidebar: true, inspector: true }, false)).toEqual({ sidebar: true, inspector: true });
  expect(settleSidePanes({ sidebar: false, inspector: true }, true)).toEqual({ sidebar: false, inspector: true });
});

it('uses a 1000px narrow threshold', () => {
  expect(NARROW_PANE_MAX_WIDTH).toBe(1000);
});
