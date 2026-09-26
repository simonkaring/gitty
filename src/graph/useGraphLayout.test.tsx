// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { appendHistory, buildEdgeIndex, createLayoutState, indexEdges, layoutHistory, type GraphCommit, type GraphLayout } from './layout';
import { useGraphLayout } from './useGraphLayout';

class LayoutWorker {
  static instances: LayoutWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  requests: { generation: number; reset: boolean; commits: GraphCommit[]; knownRows: number; knownEdges: number }[] = [];
  state = createLayoutState();
  constructor() { LayoutWorker.instances.push(this); }
  postMessage(request: LayoutWorker['requests'][number]) { this.requests.push(request); }
  terminate() { /* React owns the worker lifetime. */ }
  respond(index: number) {
    const request = this.requests[index];
    if (request.reset) this.state = createLayoutState();
    const layout = appendHistory(this.state, request.commits);
    const firstRow = request.reset ? 0 : request.knownRows;
    const firstEdge = request.reset ? 0 : request.knownEdges;
    const resolved = this.state.edges.slice(0, firstEdge).flatMap((edge, index) => {
      const target = this.state.positions.get(edge.to);
      return target && target.row >= firstRow ? [{ index, toRow: target.row, toLane: target.lane }] : [];
    });
    this.onmessage?.({ data: { generation: request.generation, firstRow, firstEdge, nodes: layout.nodes.slice(firstRow), edges: layout.edges.slice(firstEdge), resolved, laneCount: layout.laneCount, edgeMaxTo: buildEdgeIndex(layout.edges) } } as MessageEvent<unknown>);
  }
}

const nativeWorker = globalThis.Worker;
afterEach(() => { globalThis.Worker = nativeWorker; LayoutWorker.instances = []; });

it('keeps stale replies out of the graph, appends only new pages and resets on a changed head', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.Worker = LayoutWorker as unknown as typeof Worker;
  const host = document.createElement('div');
  const root = createRoot(host);
  let commits: GraphCommit[] = [{ id: 'a', parents: ['b'] }];
  let latest: GraphLayout = layoutHistory([]);
  function View({ entries }: { entries: GraphCommit[] }) {
    const { count, layout } = useGraphLayout(entries);
    latest = layout;
    return <span>{`${count}:${layout.nodes.map(node => node.id).join(',')}`}</span>;
  }
  try {
    await act(async () => { root.render(<View entries={commits} />); });
    const worker = LayoutWorker.instances[0];
    expect(host.textContent).toBe('0:');
    commits = [...commits, { id: 'b', parents: ['c'] }];
    await act(async () => { root.render(<View entries={commits} />); });
    expect(worker.requests[1]).toMatchObject({ reset: false, commits: [{ id: 'b', parents: ['c'] }] });
    await act(async () => { worker.respond(0); });
    expect(host.textContent).toBe('0:');
    await act(async () => { worker.respond(1); });
    expect(host.textContent).toBe('2:a,b');
    commits = [...commits, { id: 'c', parents: [] }];
    await act(async () => { root.render(<View entries={commits} />); });
    expect(worker.requests[2]).toMatchObject({ knownRows: 2, knownEdges: 2, commits: [{ id: 'c', parents: [] }] });
    await act(async () => { worker.respond(2); });
    expect(host.textContent).toBe('3:a,b,c');
    expect(latest.nodes).toEqual(layoutHistory(commits).nodes);
    expect(latest.edges).toEqual(layoutHistory(commits).edges);
    expect(indexEdges(latest.edges, latest.edgeMaxTo)(0, 3)).toEqual(latest.edges);
    commits = [{ id: 'working', parents: ['a'] }, ...commits];
    await act(async () => { root.render(<View entries={commits} />); });
    expect(host.textContent).toBe('0:');
    expect(worker.requests[3].reset).toBe(true);
    await act(async () => { worker.respond(3); });
    expect(host.textContent).toBe('4:working,a,b,c');
  } finally {
    await act(async () => { root.unmount(); });
  }
});
