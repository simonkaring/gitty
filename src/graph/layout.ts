export interface GraphCommit { id: string; parents: readonly string[] }
export interface GraphNode { id: string; row: number; lane: number }
export interface GraphEdge { from: string; to: string; fromRow: number; toRow: number; fromLane: number; toLane: number; track: number }
export interface GraphLayout { nodes: GraphNode[]; edges: GraphEdge[]; laneCount: number }

/**
 * Streaming lane reservation. A pending parent owns its lane until consumed.
 * Appending older commits never changes existing nodes or edge tracks.
 * Missing parents end at the loaded boundary rather than inventing a commit.
 * No canvas, DOM, dates or branch-name dependencies.
 */
export function layoutHistory(commits: readonly GraphCommit[]): GraphLayout {
  const slots: (string | null)[] = [];
  const nodes: GraphNode[] = [];
  const pending: Omit<GraphEdge, 'toRow' | 'toLane'>[] = [];
  const positions = new Map<string, GraphNode>();
  let laneCount = 1;
  function reserve(id: string): number {
    const existing = slots.indexOf(id);
    if (existing >= 0) return existing;
    const empty = slots.indexOf(null);
    const lane = empty >= 0 ? empty : slots.length;
    slots[lane] = id;
    return lane;
  }
  commits.forEach((commit, row) => {
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
      pending.push({ from: commit.id, to: parent, fromRow: row, fromLane: lane, track });
    });
    laneCount = Math.max(laneCount, slots.length, lane + 1);
    while (slots.length && slots[slots.length - 1] === null) slots.pop();
  });
  const edges = pending.map(edge => {
    const target = positions.get(edge.to);
    return { ...edge, toRow: target?.row ?? commits.length, toLane: target?.lane ?? edge.track };
  });
  return { nodes, edges, laneCount };
}

export const ROW_HEIGHT = 44;
export const LANE_WIDTH = 18;
export const LANE_PADDING = 22;
export const laneX = (lane: number) => LANE_PADDING + lane * LANE_WIDTH;

/** Viewport-sized rendering, including edges whose endpoints are both offscreen. */
export function visibleEdges(edges: readonly GraphEdge[], start: number, end: number) {
  return edges.filter(edge => edge.fromRow < end && edge.toRow >= start);
}

/** Immutable interval index: skip entire subtrees above/below the viewport while
 * retaining long parent edges whose two endpoints are both offscreen. */
export function indexEdges(edges: readonly GraphEdge[]) {
  interface IntervalNode { edge: GraphEdge; minFrom: number; maxTo: number; left?: IntervalNode; right?: IntervalNode }
  // Layout emits source-row order. Sorting a copy also supports other callers.
  const sorted = [...edges].sort((a, b) => a.fromRow - b.fromRow);
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
