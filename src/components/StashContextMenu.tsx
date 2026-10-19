import { useEffect, useState } from 'react';
import type { StashEntry } from '../model/remote';
import { useContextMenu } from './useContextMenu';

export interface StashMenuTarget { stash: StashEntry; x: number; y: number; trigger: HTMLElement }

/** Shared stash menu for graph rows and sidebar entries. Deleting is a
 * two-step item because a drop removes the reflog entry. */
export function StashContextMenu({ target, busy, canPop, onPop, onDrop, onEditMessage, onClose }: {
  target: StashMenuTarget;
  busy: boolean;
  canPop: boolean;
  onPop: (stash: StashEntry) => void;
  onDrop: (stash: StashEntry) => void;
  onEditMessage: (stash: StashEntry) => void;
  onClose: () => void;
}) {
  const { menu, position } = useContextMenu(target, onClose);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [target]);
  const { stash } = target;
  return <div ref={menu} className="menu graph-context-menu" role="menu" aria-label={`Actions for ${stash.selector}`} style={position}>
    <button role="menuitem" disabled={busy || !canPop} title={!canPop ? 'Commit or stash changes before popping.' : undefined} onClick={() => onPop(stash)}>Pop stash</button>
    <button role="menuitem" disabled={busy} data-danger={confirming ? 'true' : undefined} onClick={() => confirming ? onDrop(stash) : setConfirming(true)}>{confirming ? 'Confirm delete' : 'Delete stash'}</button>
    <div className="menu-divider" role="separator" />
    <button role="menuitem" disabled={busy} onClick={() => onEditMessage(stash)}>Edit stash message…</button>
  </div>;
}
