import { appendHistory, buildEdgeIndex, createLayoutState, type GraphCommit } from './layout';

let state = createLayoutState();

self.onmessage = (event: MessageEvent<{ generation: number; reset: boolean; commits: GraphCommit[]; knownRows: number; knownEdges: number }>) => {
  const { generation, reset, commits, knownRows, knownEdges } = event.data;
  try {
    if (reset) state = createLayoutState();
    const layout = appendHistory(state, commits);
    const firstRow = reset ? 0 : knownRows;
    const firstEdge = reset ? 0 : knownEdges;
    // The append reports exactly the prior edges it re-pointed; nothing scans
    // or allocates the full edge list again.
    const resolved = state.lastResolved.filter(index => index < firstEdge)
      .map(index => ({ index, toRow: state.edges[index].toRow, toLane: state.edges[index].toLane }));
    const edgeMaxTo = buildEdgeIndex(layout.edges);
    (self as unknown as { postMessage: (message: unknown, transfer: Transferable[]) => void })
      .postMessage({ generation, firstRow, firstEdge, nodes: layout.nodes.slice(firstRow), edges: layout.edges.slice(firstEdge), resolved, laneCount: layout.laneCount, edgeMaxTo }, [edgeMaxTo.buffer as ArrayBuffer]);
  } catch (error) {
    self.postMessage({ generation, error: error instanceof Error ? error.message : String(error) });
  }
};
