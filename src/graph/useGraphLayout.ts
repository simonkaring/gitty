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

/** Only expose rows backed by a matching layout; worker replies from old walks are ignored. */
export function useGraphLayout(commits: readonly GraphCommit[]): { layout: GraphLayout; count: number } {
  const worker = useRef<Worker | null>(null);
  const submitted = useRef<readonly GraphCommit[]>([]);
  const generation = useRef(0);
  const [result, setResult] = useState<{ commits: readonly GraphCommit[]; layout: GraphLayout }>({ commits: [], layout: EMPTY });

  useEffect(() => {
    if (typeof Worker === 'undefined') return;
    const instance = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    submitted.current = [];
    instance.onmessage = (event: MessageEvent<{ generation: number; firstRow: number; firstEdge: number; nodes: GraphNode[]; edges: GraphEdge[]; resolved: { index: number; toRow: number; toLane: number }[]; laneCount: number; edgeMaxTo: Int32Array; error?: string }>) => {
      if (event.data.generation !== generation.current) return;
      if (event.data.error) {
        console.error('Graph layout failed:', event.data.error);
        setResult({ commits: submitted.current, layout: layoutHistory(submitted.current) });
        return;
      }
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
      // Non-browser renderers and environments without workers retain the pure layout.
      setResult({ commits, layout: layoutHistory(commits) });
      return;
    }
    const reset = !samePrefix(submitted.current, commits);
    if (!reset && submitted.current.length === commits.length) return;
    const suffix = reset ? commits : commits.slice(submitted.current.length);
    submitted.current = commits;
    const valid = !reset && samePrefix(result.commits, commits);
    worker.current.postMessage({ generation: ++generation.current, reset, commits: suffix, knownRows: valid ? result.layout.nodes.length : 0, knownEdges: valid ? result.layout.edges.length : 0 });
  }, [commits, result]);

  if (!samePrefix(result.commits, commits)) return { layout: EMPTY, count: 0 };
  return { layout: result.layout, count: result.commits.length };
}
