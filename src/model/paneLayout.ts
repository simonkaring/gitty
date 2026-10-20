/** Width at or below which the workspace allows only one open side pane.
 * Accounts for the widest persisted panes (340px sidebar + 400px inspector) so
 * the history keeps at least its branch and graph columns. */
export const NARROW_PANE_MAX_WIDTH = 1000;

export interface SidePaneState {
  sidebar: boolean;
  inspector: boolean;
}

export type SidePane = keyof SidePaneState;

/** On narrow windows only one side pane may stay open, so the history keeps room
 * for its branch and graph columns. Opening a pane closes the other; closing only
 * closes the named pane. */
export function setPaneOpen(state: SidePaneState, pane: SidePane, open: boolean, narrow: boolean): SidePaneState {
  if (!open) return { ...state, [pane]: false };
  return narrow ? { sidebar: pane === 'sidebar', inspector: pane === 'inspector' } : { ...state, [pane]: true };
}

/** Resizing into narrow mode with both panes open closes the inspector and keeps
 * the sidebar, which owns branch/reference navigation. */
export function settleSidePanes(state: SidePaneState, narrow: boolean): SidePaneState {
  return narrow && state.sidebar && state.inspector ? { ...state, inspector: false } : state;
}
