export interface GraphCommit { id: string; parents: readonly string[] }
export interface GraphNode { id: string; row: number; lane: number }
export interface GraphEdge { from: string; to: string; fromRow: number; toRow: number; fromLane: number; toLane: number; track: number }
export interface GraphLayout { nodes: GraphNode[]; edges: GraphEdge[]; laneCount: number; edgeMaxTo?: Int32Array }

/** Mutable, worker-owned state for appending older pages to a pinned walk. */
export interface LayoutState {
  slots: (string | null)[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: Map<string, GraphNode>;
  laneCount: number;
}

export function createLayoutState(): LayoutState {
  return { slots: [], nodes: [], edges: [], positions: new Map(), laneCount: 1 };
}

/**
 * Streaming lane reservation. A pending parent owns its lane until consumed.
 * Appending older commits never changes existing nodes or edge tracks.
 * Missing parents end at the loaded boundary rather than inventing a commit.
 * No canvas, DOM, dates or branch-name dependencies.
 */
export function layoutHistory(commits: readonly GraphCommit[]): GraphLayout {
  return appendHistory(createLayoutState(), commits);
}

export function appendHistory(state: LayoutState, commits: readonly GraphCommit[]): GraphLayout {
  const { slots, nodes, edges, positions } = state;
  function reserve(id: string): number {
    const existing = slots.indexOf(id);
    if (existing >= 0) return existing;
    const empty = slots.indexOf(null);
    const lane = empty >= 0 ? empty : slots.length;
    slots[lane] = id;
    return lane;
  }
  commits.forEach(commit => {
    const row = nodes.length;
    if (positions.has(commit.id)) throw new Error(`Duplicate commit: ${commit.id}`);
    const lane = reserve(commit.id);
    const node = { id: commit.id, row, lane };
    nodes.push(node);
    positions.set(commit.id, node);
    slots[lane] = null;
    [...new Set(commit.parents)].forEach((parent, index) => {
      if (positions.has(parent)) throw new Error(`History is not child-before-parent: ${parent}`);
      let track = slots.indexOf(parent);
      if (track < 0) {
        if (index === 0) { slots[lane] = parent; track = lane; }
        else track = reserve(parent);
      }
      edges.push({ from: commit.id, to: parent, fromRow: row, fromLane: lane, track, toRow: row + 1, toLane: track });
    });
    state.laneCount = Math.max(state.laneCount, slots.length, lane + 1);
    while (slots.length && slots[slots.length - 1] === null) slots.pop();
  });
  // Do not mutate previous snapshots: callers may still be painting the prior page.
  const resolved = edges.map(edge => {
    const target = positions.get(edge.to);
    return { ...edge, toRow: target?.row ?? nodes.length, toLane: target?.lane ?? edge.track };
  });
  return { nodes: [...nodes], edges: resolved, laneCount: state.laneCount };
}

export const ROW_HEIGHT = 36;
export const LANE_WIDTH = 18;
export const LANE_PADDING = 22;
export const laneX = (lane: number) => LANE_PADDING + lane * LANE_WIDTH;

/** Viewport-sized rendering, including edges whose endpoints are both offscreen. */
export function visibleEdges(edges: readonly GraphEdge[], start: number, end: number) {
  return edges.filter(edge => edge.fromRow < end && edge.toRow >= start);
}

/** Build the interval pruning index off the main thread alongside lane layout. */
export function buildEdgeIndex(edges: readonly GraphEdge[]): Int32Array {
  const maxTo = new Int32Array(edges.length * 4 + 1);
  function build(node: number, start: number, end: number): number {
    if (start >= end) return -1;
    if (end - start === 1) return maxTo[node] = edges[start].toRow;
    const middle = (start + end) >>> 1;
    return maxTo[node] = Math.max(build(node * 2, start, middle), build(node * 2 + 1, middle, end));
  }
  build(1, 0, edges.length);
  return maxTo;
}

/** Immutable interval index: skip entire subtrees above/below the viewport while
 * retaining long parent edges whose two endpoints are both offscreen. */
export function indexEdges(edges: readonly GraphEdge[], edgeMaxTo?: Int32Array) {
  if (edgeMaxTo) {
    return (start: number, end: number): GraphEdge[] => {
      const result: GraphEdge[] = [];
      function visit(node: number, first: number, last: number) {
        if (first >= last || edgeMaxTo![node] < start || edges[first].fromRow >= end) return;
        if (last - first === 1) {
          if (edges[first].toRow >= start) result.push(edges[first]);
          return;
        }
        const middle = (first + last) >>> 1;
        visit(node * 2, first, middle);
        visit(node * 2 + 1, middle, last);
      }
      visit(1, 0, edges.length);
      return result;
    };
  }
  interface IntervalNode { edge: GraphEdge; minFrom: number; maxTo: number; left?: IntervalNode; right?: IntervalNode }
  // Layout emits source-row order; avoid a full sort for the common path.
  const ordered = edges.every((edge, i) => i === 0 || edges[i - 1].fromRow <= edge.fromRow);
  const sorted = ordered ? edges : [...edges].sort((a, b) => a.fromRow - b.fromRow);
  function build(start: number, end: number): IntervalNode | undefined {
    if (start >= end) return;
    const middle = (start + end) >>> 1;
    const left = build(start, middle), right = build(middle + 1, end);
    const edge = sorted[middle];
    return { edge, left, right, minFrom: sorted[start].fromRow, maxTo: Math.max(edge.toRow, left?.maxTo ?? -1, right?.maxTo ?? -1) };
  }
  const root = build(0, sorted.length);
  return (start: number, end: number): GraphEdge[] => {
    const result: GraphEdge[] = [];
    function visit(node?: IntervalNode) {
      if (!node || node.maxTo < start || node.minFrom >= end) return;
      visit(node.left);
      if (node.edge.fromRow < end && node.edge.toRow >= start) result.push(node.edge);
      visit(node.right);
    }
    visit(root);
    return result;
  };
}
