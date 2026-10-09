import { useEffect, useRef, useState } from 'react';
import { layoutHistory, type GraphCommit, type GraphEdge, type GraphLayout, type GraphNode } from './layout';

const EMPTY = layoutHistory([]);

function samePrefix(left: readonly GraphCommit[], right: readonly GraphCommit[]): boolean {
  if (left === right) return true;
  return left.length <= right.length && left.every((commit, index) => {
    const next = right[index];
    return commit.id === next.id && commit.parents.length === next.parents.length && commit.parents.every((parent, i) => parent === next.parents[i]);
  });
}

/** Above this many commits a failed layout worker is not replaced by a synchronous
 * main-thread layout; the failure is reported through `error` instead. */
export const FALLBACK_SYNC_LIMIT = 5000;

/** Only expose rows backed by a matching layout; worker replies from old walks are ignored.
 * If the worker cannot start or fails, histories up to FALLBACK_SYNC_LIMIT commits are laid out
 * synchronously; larger ones leave the graph pending and set `error`. */
export function useGraphLayout(commits: readonly GraphCommit[]): { layout: GraphLayout; count: number; error?: string } {
  const worker = useRef<Worker | null>(null);
  const submitted = useRef<readonly GraphCommit[]>([]);
  const generation = useRef(0);
  const failedRef = useRef<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<{ commits: readonly GraphCommit[]; layout: GraphLayout }>({ commits: [], layout: EMPTY });

  useEffect(() => {
    if (typeof Worker === 'undefined') return;
    failedRef.current = null;
    function fail(instance: Worker | null, reason: string) {
      if (instance && worker.current !== instance) return;
      console.error('Graph layout failed:', reason);
      generation.current++;
      worker.current = null;
      failedRef.current = reason;
      try { instance?.terminate(); } catch { /* already gone */ }
      setFailure(reason);
    }
    let instance: Worker;
    try {
      instance = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      fail(null, error instanceof Error ? error.message : String(error));
      return;
    }
    worker.current = instance;
    submitted.current = [];
    instance.onerror = event => fail(instance, event.message || 'the layout worker crashed');
    instance.onmessageerror = () => fail(instance, 'the layout worker sent an unreadable message');
    instance.onmessage = (event: MessageEvent<{ generation: number; firstRow: number; firstEdge: number; nodes: GraphNode[]; edges: GraphEdge[]; resolved: { index: number; toRow: number; toLane: number }[]; laneCount: number; edgeMaxTo: Int32Array; error?: string }>) => {
      if (event.data.generation !== generation.current) return;
      if (event.data.error) { fail(instance, event.data.error); return; }
      setResult(previous => {
        const { firstRow, firstEdge, nodes, edges, resolved, laneCount, edgeMaxTo } = event.data;
        const prior = previous.layout.nodes.length === firstRow && previous.layout.edges.length === firstEdge
          && samePrefix(previous.commits, submitted.current) ? previous.layout : EMPTY;
        if (prior.nodes.length !== firstRow || prior.edges.length !== firstEdge) return previous;
        const updatedEdges = [...prior.edges, ...edges];
        for (const change of resolved) updatedEdges[change.index] = { ...updatedEdges[change.index], toRow: change.toRow, toLane: change.toLane };
        return { commits: submitted.current, layout: { nodes: [...prior.nodes, ...nodes], edges: updatedEdges, laneCount, edgeMaxTo } };
      });
    };
    return () => { generation.current++; worker.current = null; instance.terminate(); };
  }, []);

  useEffect(() => {
    if (!worker.current) {
      // Environments without workers keep the pure layout; after a worker failure it is bounded.
      if (failedRef.current !== null && commits.length > FALLBACK_SYNC_LIMIT) return;
      if (result.commits !== commits) setResult({ commits, layout: layoutHistory(commits) });
      return;
    }
    const reset = !samePrefix(submitted.current, commits);
    if (!reset && submitted.current.length === commits.length) return;
    const suffix = reset ? commits : commits.slice(submitted.current.length);
    submitted.current = commits;
    const valid = !reset && samePrefix(result.commits, commits);
    worker.current.postMessage({ generation: ++generation.current, reset, commits: suffix, knownRows: valid ? result.layout.nodes.length : 0, knownEdges: valid ? result.layout.edges.length : 0 });
  }, [commits, result, failure]);

  const error = failure !== null && commits.length > FALLBACK_SYNC_LIMIT ? failure : undefined;
  if (!samePrefix(result.commits, commits)) return { layout: EMPTY, count: 0, error };
  return { layout: result.layout, count: result.commits.length, error };
}
