import { useEffect, useRef } from 'react';

export function SwitchBlockedDialog({ branch, reason, hasChanges, onReview, onOperations, onClose }: {
  branch: string; reason: string; hasChanges: boolean;
  onReview: () => void; onOperations: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="dialog operation-dialog" aria-label="Branch switch blocked" onCancel={onClose}>
    <h2>Could not switch to {branch}</h2>
    <p role="alert">{reason}</p>
    <p>Your working files were not discarded or stashed. Resolve the issue before trying again.</p>
    <div className="operation-buttons">
      {hasChanges && <button onClick={onReview}>Review working changes</button>}
      <button onClick={onOperations}>Open branch operations…</button>
      <button onClick={onClose}>Close</button>
    </div>
  </dialog>;
}
