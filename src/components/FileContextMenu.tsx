import { createPortal } from 'react-dom';
import type { StatusEntry } from '../model/repository';
import { discardableEntries } from '../model/workflow';
import type { WorkingGroup } from '../model/native';
import { useContextMenu, type MenuAnchor } from './useContextMenu';

export interface FileMenuTarget extends MenuAnchor { entry: StatusEntry; kind: WorkingGroup }

const platform = () => typeof navigator === 'undefined' ? '' : document.documentElement.dataset.platform ?? navigator.platform;
const revealLabel = () => /mac/i.test(platform()) ? 'Reveal in Finder' : /win/i.test(platform()) ? 'Show in File Explorer' : 'Show in file manager';

/** Right-click menu for one row of the working-changes list. `blocked` stops writes while
 * another is running; `native` is false in the browser demo, which has no real files. */
export function FileContextMenu({ target, blocked, native, onToggleStage, onDiscard, onIgnore, onCopy, onOpen, onReveal, onClose }: {
  target: FileMenuTarget; blocked: boolean; native: boolean;
  onToggleStage: () => void; onDiscard: () => void; onIgnore: () => void;
  onCopy: (value: string, label: string) => void; onOpen: () => void; onReveal: () => void; onClose: () => void;
}) {
  const { menu, position } = useContextMenu(target, onClose);
  const { entry, kind } = target;
  const name = entry.path.replace(/\/$/, '').split('/').pop() ?? entry.path;
  const missing = (kind === 'staged' ? entry.indexStatus : entry.worktreeStatus) === 'D';
  const run = (action: () => void) => () => { onClose(); action(); };
  return createPortal(<div ref={menu} className="menu graph-context-menu" role="menu" aria-label={`Actions for ${entry.path}`} style={position}>
    {kind !== 'conflict' && <button role="menuitem" disabled={blocked} onClick={run(onToggleStage)}>{kind === 'staged' ? 'Unstage' : 'Stage'}</button>}
    {kind !== 'conflict' && kind !== 'staged' && discardableEntries([entry]).length > 0 && <button role="menuitem" data-danger="true" disabled={blocked} onClick={run(onDiscard)}>Discard changes…</button>}
    {kind === 'untracked' && <button role="menuitem" disabled={blocked || !native} onClick={run(onIgnore)}>Add to .gitignore</button>}
    {kind !== 'conflict' && <div className="menu-divider" role="separator" />}
    <button role="menuitem" onClick={run(() => onCopy(entry.path, 'path'))}>Copy path</button>
    <button role="menuitem" onClick={run(() => onCopy(name, 'file name'))}>Copy file name</button>
    <div className="menu-divider" role="separator" />
    <button role="menuitem" disabled={!native || missing} onClick={run(onOpen)}>Open file</button>
    <button role="menuitem" disabled={!native || missing} onClick={run(onReveal)}>{revealLabel()}</button>
  </div>, document.body);
}
