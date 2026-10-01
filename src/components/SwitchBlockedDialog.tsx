import { Dialog } from './ui';

export function SwitchBlockedDialog({ branch, reason, hasChanges, onReview, onOperations, onClose }: {
  branch: string; reason: string; hasChanges: boolean;
  onReview: () => void; onOperations: () => void; onClose: () => void;
}) {
  return <Dialog title={`Could not switch to ${branch}`} size="sm" onClose={onClose} footer={<>
    {hasChanges && <button className="secondary-button" onClick={onReview}>Review working changes</button>}
    <span className="spacer" />
    <button className="secondary-button" onClick={onClose}>Close</button>
    <button className="primary-button" onClick={onOperations}>Branch operations…</button>
  </>}>
    <p className="alert" role="alert">{reason}</p>
    <p className="muted">Your working files were not discarded or stashed. Resolve the issue before trying again.</p>
  </Dialog>;
}
