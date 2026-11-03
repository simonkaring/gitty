import { useEffect, useState } from 'react';
import { native } from '../model/native';
import { commitGraphDismissed, dismissCommitGraph, suggestCommitGraph, type CommitGraphStatus } from '../model/commitGraph';
import { Toast } from './ui';

export function CommitGraphNotice({ handle, repositoryKey, active, firstPageMs, busy, onRun }: {
  handle: string; repositoryKey: string; active: boolean; firstPageMs: number; busy: boolean; onRun: () => void;
}) {
  const [status, setStatus] = useState<CommitGraphStatus | null>(null);
  const [dismissed, setDismissed] = useState(() => commitGraphDismissed(repositoryKey));
  useEffect(() => {
    if (!active) return;
    let live = true;
    native<CommitGraphStatus>('repository_commit_graph_status', { handle }).then(value => { if (live) setStatus(value); }).catch(() => { /* Optional advice must not block repository use. */ });
    return () => { live = false; };
  }, [handle, active]);
  if (!active || !suggestCommitGraph(status, firstPageMs, dismissed)) return null;
  return <Toast onDismiss={() => { dismissCommitGraph(repositoryKey); setDismissed(true); }} action={<button className="secondary-button" disabled={busy} onClick={onRun}>Speed up history</button>}>History loads faster with a commit-graph.</Toast>;
}
