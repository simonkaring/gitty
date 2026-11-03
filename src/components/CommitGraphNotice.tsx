import { useEffect, useRef, useState } from 'react';
import { native } from '../model/native';
import { commitGraphDismissed, dismissCommitGraph, suggestCommitGraph, type CommitGraphStatus } from '../model/commitGraph';
import { Toast } from './ui';

export function CommitGraphNotice({ handle, repositoryKey, active, firstPageMs, busy, revision = 0, onRun }: {
  handle: string; repositoryKey: string; active: boolean; firstPageMs: number; busy: boolean; revision?: number; onRun: () => void;
}) {
  const [status, setStatus] = useState<CommitGraphStatus | null>(null);
  const [dismissed, setDismissed] = useState(() => commitGraphDismissed(repositoryKey));
  const cached = useRef<{ handle: string; revision: number; request: Promise<CommitGraphStatus> } | null>(null);
  useEffect(() => { setDismissed(commitGraphDismissed(repositoryKey)); }, [repositoryKey]);
  useEffect(() => {
    if (!active || busy) return;
    let live = true;
    if (cached.current?.handle !== handle || cached.current.revision !== revision) {
      setStatus(null);
      cached.current = { handle, revision, request: native<CommitGraphStatus>('repository_commit_graph_status', { handle }) };
    }
    cached.current.request.then(value => { if (live) setStatus(value); }).catch(() => { /* Optional advice must not block repository use. */ });
    return () => { live = false; };
  }, [handle, active, busy, revision]);
  if (!active || busy || !suggestCommitGraph(status, firstPageMs, dismissed)) return null;
  return <Toast onDismiss={() => { dismissCommitGraph(repositoryKey); setDismissed(true); }} action={<button className="secondary-button" disabled={busy} onClick={onRun}>Speed up history</button>}>History loads faster with a commit-graph.</Toast>;
}
