import { isDemoHandle } from '../model/native';
import type { RepositoryState } from '../model/repository';
import { folderDeleteTargets, folderLabel, type BranchDeleteScope, type BranchFolder } from '../model/branchDelete';
import { useContextMenu, type MenuAnchor } from './useContextMenu';

export interface FolderMenuTarget extends MenuAnchor { folder: BranchFolder }

export function BranchFolderMenu({ target, state, busy, onDelete, onClose }: {
  target: FolderMenuTarget; state: RepositoryState; busy: boolean;
  onDelete: (folder: BranchFolder, scope: BranchDeleteScope) => void; onClose: () => void;
}) {
  const { menu, position } = useContextMenu(target, onClose);
  const { folder } = target;
  const demo = isDemoHandle(state.session.handle);
  const single: BranchDeleteScope = folder.kind === 'local' ? 'local' : 'origin';
  const count = (scope: BranchDeleteScope) => folderDeleteTargets(state, folder, scope).entries.length;
  const plural = (n: number) => `${n} ${n === 1 ? 'branch' : 'branches'}`;
  const singleCount = count(single);
  const bothCount = count('both');
  const reason = demo ? 'Branch deletion is unavailable in the demo.' : undefined;
  return <div ref={menu} className="menu graph-context-menu" role="menu" aria-label={`Actions for folder ${folderLabel(folder)}`} style={position}>
    <button role="menuitem" disabled={busy || demo || !singleCount} title={reason} onClick={() => onDelete(folder, single)}>
      {folder.kind === 'local' ? `Delete ${plural(singleCount).replace('branch', 'local branch')}…` : `Delete ${plural(singleCount)} on origin…`}{demo ? ' (unavailable in demo)' : ''}
    </button>
    {bothCount > 0 && <button role="menuitem" disabled={busy || demo} title={reason} onClick={() => onDelete(folder, 'both')}>Delete {bothCount} local and origin {bothCount === 1 ? 'branch' : 'branches'}…{demo ? ' (unavailable in demo)' : ''}</button>}
  </div>;
}
