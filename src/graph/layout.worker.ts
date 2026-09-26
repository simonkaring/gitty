import { appendHistory, buildEdgeIndex, createLayoutState, type GraphCommit } from './layout';

let state = createLayoutState();

self.onmessage = (event: MessageEvent<{ generation: number; reset: boolean; commits: GraphCommit[]; knownRows: number; knownEdges: number }>) => {
  const { generation, reset, commits, knownRows, knownEdges } = event.data;
  try {
    if (reset) state = createLayoutState();
    const layout = appendHistory(state, commits);
    const firstRow = reset ? 0 : knownRows;
    const firstEdge = reset ? 0 : knownEdges;
    const resolved = state.edges.slice(0, firstEdge).flatMap((edge, index) => {
      const target = state.positions.get(edge.to);
      return target && target.row >= firstRow ? [{ index, toRow: target.row, toLane: target.lane }] : [];
    });
    const edgeMaxTo = buildEdgeIndex(layout.edges);
    (self as unknown as { postMessage: (message: unknown, transfer: Transferable[]) => void })
      .postMessage({ generation, firstRow, firstEdge, nodes: layout.nodes.slice(firstRow), edges: layout.edges.slice(firstEdge), resolved, laneCount: layout.laneCount, edgeMaxTo }, [edgeMaxTo.buffer as ArrayBuffer]);
  } catch (error) {
    self.postMessage({ generation, error: error instanceof Error ? error.message : String(error) });
  }
};
