import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icons } from './icons';
import { indexEdges, laneX, LANE_WIDTH, ROW_HEIGHT, type GraphEdge, type GraphLayout } from '../graph/layout';
import { assignBranchColors, branchName, stashBranches } from '../graph/branchColor';
import { WORKING_ID } from '../model/native';
import type { Commit, GitRef } from '../model/types';
import type { ActionContext } from './OperationDialog';
import { DEFAULT_HISTORY_COLUMNS, useSettings, type HistoryColumnId, type ThemeDefinition } from '../model/settings';
import { COLUMN_LABELS, HistoryColumnMenu } from './HistoryColumnMenu';
import { AuthorAvatar } from './AuthorAvatar';
import { commitDay, commitIsoString, formatCommitDate } from '../model/dates';
import { shapeOf, traceShape } from '../graph/shape';

const ROW_DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };

type GraphRef = GitRef & { fullName?: string };
/** Refs shown as badges, grouped once per `refs` array by commit (remote HEAD aliases such as origin/HEAD excluded), instead of filtering
 * every ref for every rendered row. */
export function groupRefsByCommit<T extends GitRef>(refs: readonly T[]): Map<string, T[]> {
  const byCommit = new Map<string, T[]>();
  for (const ref of refs) {
    if (ref.kind === 'remote' && ref.name.endsWith('/HEAD')) continue;
    const list = byCommit.get(ref.commitId);
    if (list) list.push(ref); else byCommit.set(ref.commitId, [ref]);
  }
  return byCommit;
}
const NO_REFS: GraphRef[] = [];

export interface GraphAnchor { id: string; offset: number }
export interface GraphHandle { scrollTo: (row: number) => void; anchor: () => GraphAnchor | null; restore: (anchor: GraphAnchor) => void }
export const REF_DRAG_TYPE = 'application/x-gitty-ref';
export const COMMIT_DRAG_TYPE = 'application/x-gitty-commit';
export function acceptsGraphDrop(data: DataTransfer, target: GraphRef, headRef: string | null | undefined): boolean {
  if (!headRef || !target.fullName || target.kind !== 'local') return false;
  const branchDrag = data.types.includes(REF_DRAG_TYPE), commitDrag = data.types.includes(COMMIT_DRAG_TYPE);
  return branchDrag !== commitDrag && (branchDrag || target.fullName === headRef);
}
export function graphDropAction(data: DataTransfer, targetRef: string | undefined, headRef: string | null | undefined, commits: readonly { id: string }[], refs: readonly (GitRef & { fullName?: string })[]): ActionContext | null {
  const target = refs.find(ref => ref.fullName === targetRef);
  if (!target || !acceptsGraphDrop(data, target, headRef)) return null;
  const branchDrag = data.types.includes(REF_DRAG_TYPE);
  if (branchDrag) {
    const source = data.getData(REF_DRAG_TYPE);
    const actual = refs.find(ref => ref.fullName === source && ref.kind !== 'tag');
    return actual && source !== targetRef ? { oid: actual.commitId, ref: source, destination: targetRef, initial: 'merge' } : null;
  }
  const oid = data.getData(COMMIT_DRAG_TYPE);
  return oid !== WORKING_ID && commits.some(commit => commit.id === oid) ? { oid, commits: [oid], initial: 'cherryPick' } : null;
}
const REF_ORDER = { local: 0, remote: 1, tag: 2 } as const;
export function sortRefs<T extends GitRef & { fullName?: string }>(list: T[], headRef?: string | null): T[] {
  const rank = (ref: T) => ref.fullName && ref.fullName === headRef ? -1 : REF_ORDER[ref.kind as keyof typeof REF_ORDER] ?? 3;
  return [...list].sort((a, b) => rank(a) - rank(b));
}
// A local branch and its same-named remote-tracking ref on one commit share a single pill.
export function groupRefs<T extends GitRef & { fullName?: string }>(list: T[], headRef?: string | null): { ref: T; remote?: T }[] {
  const sorted = sortRefs(list, headRef), used = new Set<T>(), groups: { ref: T; remote?: T }[] = [];
  for (const ref of sorted) {
    if (used.has(ref)) continue;
    const remote = ref.kind === 'local' ? sorted.find(other => other.kind === 'remote' && !used.has(other) && other.name.slice(other.name.indexOf('/') + 1) === ref.name) : undefined;
    if (remote) used.add(remote);
    groups.push({ ref, remote });
  }
  return groups;
}
interface Props {
  commits: Commit[];
  layout: GraphLayout;
  refs: (GitRef & { fullName?: string })[];
  selectedId: string;
  head: string;
  matches: Set<string> | null;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  onOpenDetails: () => void;
  theme: ThemeDefinition;
  hasMore?: boolean;
  paging?: boolean;
  shallow?: boolean;
  headRef?: string | null;
  onActions?: (context: ActionContext) => void;
  onContextActions?: (context: ActionContext, x: number, y: number, trigger: HTMLElement) => void;
  onSwitchBranch?: (ref: string) => void;
  pickOrder?: string[];
  onTogglePick?: (oid: string) => void;
  /** Full name of a ref hovered elsewhere (the sidebar): its branch is emphasised and everything else dims. */
  highlightRef?: string | null;
}

const WIDTH_VAR: Record<HistoryColumnId, string> = { refs: 'var(--ref-width)', graph: 'var(--graph-width)', message: 'var(--message-width)', author: 'var(--author-width)', hash: 'var(--hash-width)', date: 'var(--date-width)' };
const MIN_GRAPH_WIDTH = laneX(2) + 14; // three lanes plus padding; also fits the "GRAPH" label
export const HistoryGraph = forwardRef<GraphHandle, Props>(function HistoryGraph({ commits, layout, refs, selectedId, head, matches, onSelect, onLoadMore, onOpenDetails, theme, hasMore, paging, shallow, headRef, onActions, onContextActions, onSwitchBranch, pickOrder, onTogglePick, highlightRef }, ref) {
  const uid = useId();
  const { settings, updateSettings } = useSettings();
  // Material draws every node as a shaped author avatar; other designs follow the setting.
  const material = theme.design === 'material';
  const apple = theme.design === 'apple';
  const avatars = settings.graphAuthorAvatars || material;
  // Material uses roomier rows so avatars, the HEAD ring and day dividers don't crowd each other.
  const rowHeight = material ? 52 : apple ? 34 : ROW_HEIGHT;
  const graphLaneWidth = avatars ? 30 : LANE_WIDTH;
  const graphLaneX = useMemo(() => (lane: number) => laneX(0) + lane * graphLaneWidth, [graphLaneWidth]);
  const minGraphWidth = graphLaneX(2) + 14;
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hoverRect = useRef<HTMLDivElement>(null);
  const columnSettingsButton = useRef<HTMLButtonElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [graphScroll, setGraphScroll] = useState(0);
  const [hbar, setHbar] = useState(0);
  const graphScroller = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(600);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  // Roving focus: the listbox keeps DOM focus while ArrowLeft/Right move this "active control" through the selected row's pills, pick checkbox and actions button.
  const [activeControl, setActiveControl] = useState<{ id: string; n: number } | null>(null);
  const [messageResized, setMessageResized] = useState(false);
  const [widths, setWidths] = useState<Record<HistoryColumnId, number>>({ refs: 170, graph: MIN_GRAPH_WIDTH, message: 130, author: 110, hash: 90, date: 120 });
  type Column = HistoryColumnId;
  const dateResized = useRef(false);
  const limits: Record<Column, [number, number]> = { refs: [90, 420], graph: [minGraphWidth, 600], message: [100, Math.max(600, viewportWidth)], author: [70, 260], hash: [70, 180], date: [80, 220] };
  function resize(column: Column, delta: number, initial: number) {
    if (column === 'message') setMessageResized(true);
    if (column === 'date') dateResized.current = true;
    setWidths(current => ({ ...current, [column]: Math.max(limits[column][0], Math.min(limits[column][1], initial + delta)) }));
  }
  function resizeHandle(column: Column) {
    return <button className="history-column-resize" aria-label={`Resize ${COLUMN_LABELS[column]} column`} title="Drag or use arrow keys to resize" onClick={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(column, event.key === 'ArrowRight' ? 10 : -10, column === 'message' ? event.currentTarget.parentElement!.getBoundingClientRect().width : widths[column]); } }}
      onPointerDown={event => {
        event.preventDefault();
        const target = event.currentTarget, start = event.clientX, initial = column === 'message' ? target.parentElement!.getBoundingClientRect().width : widths[column];
        target.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => resize(column, moveEvent.clientX - start, initial);
        const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end); };
        target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
      }} />;
  }
  const dragFrame = useRef(0);
  const dragVelocity = useRef(0);
  function stopDrag() { cancelAnimationFrame(dragFrame.current); dragFrame.current = 0; dragVelocity.current = 0; }
  function autoScroll() {
    if (scroller.current && dragVelocity.current) { scroller.current.scrollTop += dragVelocity.current; setScrollTop(scroller.current.scrollTop); dragFrame.current = requestAnimationFrame(autoScroll); }
    else dragFrame.current = 0;
  }
  useEffect(() => { window.addEventListener('dragend', stopDrag); window.addEventListener('drop', stopDrag, true); return () => { stopDrag(); window.removeEventListener('dragend', stopDrag); window.removeEventListener('drop', stopDrag, true); }; }, []);
  // The column keeps its own width however wide the lane tree gets; the canvas shows a window scrolled by graphScroll.
  const graphContent = Math.max(112, layout.laneCount * graphLaneWidth + 32);
  const graphWidth = Math.max(widths.graph, minGraphWidth);
  const graphScrollMax = Math.max(0, graphContent - graphWidth);
  const graphX = Math.min(graphScroll, graphScrollMax);
  const loaded = commits.length;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 8);
  const end = Math.min(loaded, Math.ceil((scrollTop + height) / rowHeight) + 8);
  // The canvas is a window of the scrolled content that moves natively with the rows, so scrolling never
  // lags behind a redraw; it is only repainted when scrolling leaves the buffered window.
  const BUFFER = rowHeight * 10;
  const windowTop = Math.max(0, Math.floor(scrollTop / BUFFER) * BUFFER - BUFFER);
  const windowHeight = Math.max(0, Math.min(height + BUFFER * 3, loaded * rowHeight - windowTop));
  const selectedIndex = useMemo(() => commits.findIndex(commit => commit.id === selectedId), [commits, selectedId]);
  const refsByCommit = useMemo(() => groupRefsByCommit(refs), [refs]);
  // First loaded commit of each calendar day, with that day's loaded count (shown as a divider label by the Material design).
  const dayStarts = useMemo(() => {
    const counts = new Map<string, number>(), starts = new Map<number, { label: string; key: string }>();
    if (!material) return { counts, starts };
    let previous = '';
    commits.forEach((commit, row) => {
      const day = commit.id === WORKING_ID ? null : commitDay(commit.timestamp);
      if (!day) return;
      counts.set(day.key, (counts.get(day.key) ?? 0) + 1);
      if (day.key !== previous) starts.set(row, day);
      previous = day.key;
    });
    return { counts, starts };
  }, [commits, material]);
  const loadedIds = useMemo(() => new Set(commits.map(commit => commit.id)), [commits]);
  const visibleEdges = useMemo(() => indexEdges(layout.edges, layout.edgeMaxTo), [layout.edges, layout.edgeMaxTo]);
  const colors = useMemo(() => Array.from({ length: 8 }, (_, index) => theme.colors[`graphLane${index + 1}` as keyof ThemeDefinition['colors']]), [theme]);
  const palette = useMemo(() => [...colors, theme.colors.accent], [colors, theme]);
  const currentBranch = headRef?.startsWith('refs/heads/') ? headRef.slice(11) : null;
  const branchColors = useMemo(() => assignBranchColors(commits, refs, WORKING_ID, currentBranch, stashBranches(commits, refs)), [commits, refs, currentBranch]);
  // The commits of a hovered branch (a tag only marks its own commit). Overrides search dimming while it lasts.
  const focus = useMemo(() => {
    const target = highlightRef ? refs.find(item => item.fullName === highlightRef) : undefined;
    if (!target) return null;
    const branch = branchName(target);
    const ids = new Set<string>(branch === null ? [target.commitId] : commits.filter((_, row) => branchColors.owned[row] === branch).map(commit => commit.id));
    return { ids, branch };
  }, [highlightRef, refs, commits, branchColors]);
  const shown = focus?.ids ?? matches;
  const columns = settings.historyColumns ?? DEFAULT_HISTORY_COLUMNS;
  const visibleColumns = useMemo(() => columns.filter(c => c.visible), [columns]);
  // A branch-coloured connector links ref pills to their node only when the refs column sits right before the graph.
  const joinRefs = visibleColumns.findIndex(c => c.id === 'graph') > 0 && visibleColumns[visibleColumns.findIndex(c => c.id === 'graph') - 1].id === 'refs';

  interface RowControls { n: number }
  const activeN = activeControl?.id === selectedId ? activeControl.n : null;
  /** Ordinals follow render (= DOM) order within a row, so ArrowRight/Left can index the row's `[data-row-control]` elements. */
  function rowControl(commitId: string, controls: RowControls) {
    const n = controls.n++;
    return { id: `${uid}-commit-${commitId}-ctl-${n}`, active: commitId === selectedId && activeN === n };
  }
  function renderRef({ ref, remote }: { ref: GitRef & { fullName?: string }; remote?: GitRef }, commit: Commit, controls: RowControls) {
    const name = branchName(ref);
    const control = ref.fullName ? rowControl(commit.id, controls) : null;
    return <span key={ref.fullName ?? ref.name} id={control?.id} data-row-control={control ? '' : undefined} className={`ref-pill ${ref.kind === 'tag' ? 'tag-ref' : ref.kind === 'remote' ? 'remote-ref' : ref.kind === 'stash' ? 'stash-ref' : ''}${control?.active ? ' row-control-active' : ''}`}
                      style={name !== null ? { '--branch-color': palette[branchColors.branches.get(name)!] } as React.CSSProperties : undefined}
                      data-name={ref.name} title={remote ? `${ref.fullName} + ${remote.name}` : ref.fullName ?? ref.name}
                      role={ref.fullName ? 'button' : undefined} tabIndex={ref.fullName ? -1 : undefined} aria-label={ref.fullName ? `Select tip of ${ref.fullName}; right-click or press Shift+F10 for actions` : undefined}
                      onKeyDown={event => { if (!ref.fullName) return; if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && onContextActions) { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onContextActions({ oid: commit.id, ref: ref.fullName }, rect.left, rect.bottom, scroller.current ?? event.currentTarget); } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelect(commit.id); } }}
                      data-current={!!headRef && ref.fullName === headRef} draggable={!!onActions && !!ref.fullName && ref.kind !== 'tag'}
                      onDragStart={event => { event.stopPropagation(); if (onActions && ref.fullName && ref.kind !== 'tag') { event.dataTransfer.clearData(COMMIT_DRAG_TYPE); event.dataTransfer.setData(REF_DRAG_TYPE, ref.fullName); event.dataTransfer.effectAllowed = 'copy'; } else event.preventDefault(); }} onDragEnd={stopDrag}
                       onDragOver={event => { if (onActions && acceptsGraphDrop(event.dataTransfer, ref, headRef)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
                      onDrop={event => { event.preventDefault(); event.stopPropagation(); stopDrag(); const action = graphDropAction(event.dataTransfer, ref.fullName, headRef, commits, refs); if (action) onActions?.(action); }}
                      onContextMenu={event => { if (onContextActions && ref.fullName) { event.preventDefault(); event.stopPropagation(); onContextActions({ oid: commit.id, ref: ref.fullName }, event.clientX, event.clientY, scroller.current ?? event.currentTarget); } }} onClick={event => { event.stopPropagation(); onSelect(commit.id); scroller.current?.focus(); }}
                      onDoubleClick={event => { if (ref.fullName && (ref.kind === 'local' || (ref.kind === 'remote' && ref.fullName.startsWith('refs/remotes/origin/') && ref.fullName !== 'refs/remotes/origin/HEAD')) && onSwitchBranch) { event.stopPropagation(); onSwitchBranch(ref.fullName); } }}>
                      {!!headRef && ref.fullName === headRef && <Icons.Check size={10} strokeWidth={3} aria-hidden="true" />}{ref.kind === 'tag' ? <Icons.Tag size={10} /> : ref.kind === 'remote' ? <Icons.Globe2 size={10} /> : ref.kind === 'stash' ? <Icons.Archive size={10} /> : <Icons.Laptop size={10} />}{remote && <Icons.Globe2 size={10} />}<span className="ref-pill-name">{ref.name}</span>
                    </span>;
  }

  function scrollTo(row: number) {
    const el = scroller.current;
    if (!el) return;
    const top = row * rowHeight;
    if (top < el.scrollTop || top + rowHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
      setScrollTop(el.scrollTop);
    }
  }
  useImperativeHandle(ref, () => ({ scrollTo, anchor: () => {
    const top = scroller.current?.scrollTop ?? 0;
    const commit = commits[Math.floor(top / rowHeight)];
    return commit ? { id: commit.id, offset: top % rowHeight } : null;
  }, restore: anchor => {
    const row = commits.findIndex(commit => commit.id === anchor.id);
    if (row >= 0 && scroller.current) { scroller.current.scrollTop = row * rowHeight + anchor.offset; setScrollTop(scroller.current.scrollTop); }
  } }));
  useLayoutEffect(() => {
    const el = scroller.current!;
    const observer = new ResizeObserver(() => { setHeight(el.clientHeight); setViewportWidth(el.clientWidth); });
    observer.observe(el);
    setHeight(el.clientHeight);
    setViewportWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Sit above the list's own horizontal scrollbar when it is showing.
  useLayoutEffect(() => { const el = scroller.current; if (el) setHbar(el.offsetHeight - el.clientHeight); });

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    // Assigning width/height clears and reallocates the backing store, so only do it when the size really changed.
    const pixelWidth = Math.floor(graphWidth * dpr), pixelHeight = Math.floor(windowHeight * dpr);
    if (element.width !== pixelWidth) element.width = pixelWidth;
    if (element.height !== pixelHeight) element.height = pixelHeight;
    const y = (row: number) => row * rowHeight + rowHeight / 2 - windowTop;
    const firstRow = Math.max(0, Math.floor(windowTop / rowHeight) - 1), lastRow = Math.min(loaded, Math.ceil((windowTop + windowHeight) / rowHeight) + 1);
    ctx.setTransform(dpr, 0, 0, dpr, -graphX * dpr, 0);
    ctx.clearRect(graphX, 0, graphWidth, windowHeight);
    ctx.lineWidth = apple ? 1.75 : 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const colorRowOf = (edge: GraphEdge) => commits[edge.fromRow]?.parents[0] === edge.to ? edge.fromRow : edge.toRow;
    const edges = visibleEdges(firstRow, lastRow);
    // With a branch hovered, its lines are drawn last so they sit on top of the dimmed ones.
    const onBranch = (edge: GraphEdge) => !!focus && focus.branch !== null && branchColors.owned[colorRowOf(edge)] === focus.branch;
    if (focus) edges.sort((a, b) => Number(onBranch(a)) - Number(onBranch(b)));
    const traceEdge = (edge: GraphEdge) => {
      const x1 = graphLaneX(edge.fromLane), xt = graphLaneX(edge.track), x2 = graphLaneX(edge.toLane);
      const y1 = y(edge.fromRow), y2 = y(edge.toRow);
      const bend = rowHeight / 4, reach = rowHeight * 5 / 12;
      // Uncommitted work hangs off HEAD by a dotted line (round caps turn near-zero dashes into dots).
      ctx.setLineDash(commits[edge.fromRow]?.id === WORKING_ID ? [0.01, 6] : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1, y1 + bend, xt, y1 + bend, xt, y1 + reach);
      ctx.lineTo(xt, y2 - reach);
      ctx.bezierCurveTo(xt, y2 - bend, x2, y2 - bend, x2, y2);
      ctx.stroke();
    };
    for (const edge of edges) {
      const colorRow = colorRowOf(edge);
      ctx.strokeStyle = palette[branchColors.rows[colorRow] ?? branchColors.rows[edge.fromRow] ?? edge.track % colors.length];
      ctx.globalAlpha = focus ? (onBranch(edge) ? 1 : 0.18) : matches ? 0.3 : 1;
      traceEdge(edge);
    }
    // Apple: content on the accent selection turns white, as in a selected macOS table row, so lines stay visible on it.
    const selectedBand = apple && selectedIndex >= firstRow && selectedIndex < lastRow;
    if (selectedBand) {
      ctx.save();
      ctx.beginPath(); ctx.rect(graphX, y(selectedIndex) - rowHeight / 2, graphWidth, rowHeight - 2); ctx.clip();
      ctx.strokeStyle = theme.colors.buttonForeground; ctx.globalAlpha = 0.9;
      edges.forEach(traceEdge);
      ctx.restore();
    }
    const erase = (paint: () => void) => { ctx.globalCompositeOperation = 'destination-out'; paint(); ctx.globalCompositeOperation = 'source-over'; };
    // The worker can still be laying out newly loaded history when this effect
    // runs. Rows remain visible, but their canvas nodes must wait for layout.
    ctx.setLineDash([]);
    for (let row = firstRow; row < Math.min(lastRow, layout.nodes.length, commits.length); row++) {
      const node = layout.nodes[row];
      const commit = commits[row];
      const working = commit.id === WORKING_ID;
      const x = graphLaneX(node.lane), cy = y(row);
      const onSelection = selectedBand && row === selectedIndex;
      const lane = onSelection ? theme.colors.buttonForeground : palette[branchColors.rows[row] ?? node.lane % colors.length];
      const alpha = shown && !shown.has(node.id) ? (focus ? 0.25 : 0.3) : 1;
      // Solid dots are bigger than merge dots; the selected node grows like its avatar counterpart does.
      // A stash record is a two-parent commit whose index parent is not drawn; it is not a user merge.
      const merge = commit.parents.length > 1 && !refsByCommit.get(commit.id)?.some(ref => ref.kind === 'stash'), avatarNode = avatars && !working && !(material && merge);
      const radius = (avatarNode ? (material ? 13 : 11) : apple ? (merge ? 4 : 5) : merge ? 5.5 : 7) * (commit.id === selectedId ? 1.2 : 1);
      ctx.lineWidth = 2;
      if (joinRefs && refsByCommit.has(commit.id) && x - radius - 3 > graphX) {
        ctx.globalAlpha = alpha * 0.75; ctx.strokeStyle = lane;
        ctx.beginPath(); ctx.moveTo(graphX, cy); ctx.lineTo(x - radius - 3, cy); ctx.stroke();
      }
      ctx.globalAlpha = alpha;
      if (commit.id === head) {
        // Material rings HEAD with a scalloped (cookie) outline, even around a small merge dot.
        if (material) traceShape(ctx, 'cookie', x, cy, (commit.id === selectedId ? 13 * 1.2 + 4 : 13 + 5), 0.12); else { ctx.beginPath(); ctx.arc(x, cy, radius + (avatars ? 5 : 4), 0, Math.PI * 2); }
        ctx.strokeStyle = onSelection ? theme.colors.buttonForeground : apple ? theme.colors.text : theme.colors.graphHead; ctx.stroke();
      }
      if (avatarNode) continue;
      ctx.beginPath();
      if (working) {
        // Uncommitted work is a dashed, hollow marker (a round one in Material).
        if (material) { ctx.arc(x, cy, 9, 0, Math.PI * 2); ctx.lineWidth = 2.5; } else ctx.roundRect(x - 5, cy - 5, 10, 10, 2.5);
        erase(() => ctx.fill());
        ctx.setLineDash([3, 3]); ctx.strokeStyle = lane; ctx.stroke(); ctx.setLineDash([]);
      } else {
        // Solid dot separated from lines behind it by a gap cut out of the canvas, so the row's hover or selection fill shows through.
        ctx.arc(x, cy, radius, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        erase(() => { ctx.fill(); ctx.stroke(); });
        ctx.fillStyle = lane; ctx.fill();
        erase(() => ctx.stroke());
      }
    }
    ctx.globalAlpha = 1;
  }, [commits, layout, visibleEdges, windowTop, windowHeight, graphWidth, graphX, theme, matches, focus, shown, loaded, colors, palette, branchColors, avatars, material, apple, graphLaneX, joinRefs, refsByCommit, selectedId, selectedIndex, head]);

  useEffect(() => {
    const node = layout.nodes[selectedIndex];
    const el = graphScroller.current;
    if (!node || !el) return;
    const x = graphLaneX(node.lane);
    if (x < graphX + 12) el.scrollLeft = Math.max(0, x - 24);
    else if (x > graphX + graphWidth - 12) el.scrollLeft = x - graphWidth + 24;
  }, [selectedIndex, layout.nodes, graphLaneX]); // eslint-disable-line react-hooks/exhaustive-deps

  // Working changes are synthetic row 0, so a refresh that surfaces them above a
  // scrolled list would otherwise leave them out of view behind the preserved
  // scroll anchor. Reveal the row once when it appears, not on every refresh.
  const hasWorkingRow = commits[0]?.id === WORKING_ID;
  const hadWorkingRow = useRef(hasWorkingRow);
  const revealWorking = useRef(false);
  useEffect(() => {
    if (hasWorkingRow && !hadWorkingRow.current) revealWorking.current = true;
    hadWorkingRow.current = hasWorkingRow;
    // Wait for the layout to include row 0: the parent re-anchors the list when a
    // new layout lands, so revealing on the same commit would be overwritten.
    if (revealWorking.current && layout.nodes[0]?.id === WORKING_ID && scroller.current) {
      scroller.current.scrollTop = 0;
      setScrollTop(0);
      revealWorking.current = false;
    }
  }, [commits, hasWorkingRow, layout]);

  // Commits prepended by a refresh (new commit, fetch) slide in once.
  const seenIds = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const seen = seenIds.current;
    seenIds.current = new Set(commits.map(commit => commit.id));
    if (!seen) return;
    const firstSeen = commits.findIndex(commit => seen.has(commit.id));
    if (firstSeen <= 0) return;
    setFreshIds(new Set(commits.slice(0, firstSeen).map(commit => commit.id)));
    const timer = setTimeout(() => setFreshIds(new Set()), 1200);
    return () => clearTimeout(timer);
  }, [commits]);

  function navigate(row: number) {
    if (!loaded) return;
    const next = Math.max(0, Math.min(loaded - 1, row));
    onSelect(commits[next].id);
    scrollTo(next);
  }

  const activeControlId = activeN === null ? null : `${uid}-commit-${selectedId}-ctl-${activeN}`;
  // Drop an active control whose element is gone (row scrolled out, refs or columns changed) so aria-activedescendant never dangles.
  useLayoutEffect(() => { if (activeControlId && !scroller.current?.querySelector(`[id="${activeControlId}"]`)) setActiveControl(null); });
  const columnWidth = (id: Column) => (id === 'graph' ? graphWidth : widths[id]);
  // Until the user drags the Date column, it grows (never shrinks, so scrolling doesn't jitter) to show the whole date.
  const dateVisible = visibleColumns.some(c => c.id === 'date');
  useLayoutEffect(() => {
    if (!dateVisible || dateResized.current) return;
    let needed = 0;
    const range = document.createRange();
    scroller.current?.querySelectorAll<HTMLElement>('.row-date').forEach(cell => {
      range.selectNodeContents(cell);
      needed = Math.max(needed, range.getBoundingClientRect().width + parseFloat(getComputedStyle(cell).paddingLeft));
    });
    needed = Math.min(Math.ceil(needed) + 12, 320);
    if (needed > widths.date) setWidths(current => ({ ...current, date: needed }));
  }, [dateVisible, start, end, commits, widths.date, settings.fontSize, settings.monoFont]);

  const gridTemplateColumns = useMemo(
    () =>
      visibleColumns
        .map(c => c.id === 'message' && !messageResized ? `minmax(${WIDTH_VAR.message}, 1fr)` : WIDTH_VAR[c.id])
        .join(' '),
    [visibleColumns, messageResized]
  );

  const totalWidth = useMemo(
    () => visibleColumns.reduce((sum, col) => sum + columnWidth(col.id), 0),
    [visibleColumns, widths, graphWidth]
  );

  const graphOffset = useMemo(() => {
    let offset = 0;
    for (const col of visibleColumns) {
      if (col.id === 'graph') break;
      offset += columnWidth(col.id);
      if (col.id === 'message' && !messageResized) offset += Math.max(0, viewportWidth - totalWidth);
    }
    return offset;
  }, [visibleColumns, widths, graphWidth, viewportWidth, totalWidth, messageResized]);

  // Shift+wheel or a horizontal trackpad swipe over the graph column pans the graph, not the whole list.
  useEffect(() => {
    const list = scroller.current;
    if (!list || !graphScrollMax) return;
    const wheel = (event: WheelEvent) => {
      const x = event.clientX - list.getBoundingClientRect().left + list.scrollLeft;
      const delta = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      if (!delta || Math.abs(event.deltaX) < Math.abs(event.deltaY) && !event.shiftKey || x < graphOffset || x > graphOffset + graphWidth || !graphScroller.current) return;
      event.preventDefault();
      graphScroller.current.scrollLeft += delta;
    };
    list.addEventListener('wheel', wheel, { passive: false });
    return () => list.removeEventListener('wheel', wheel);
  }, [graphScrollMax, graphOffset, graphWidth]);

  const isGraphVisible = visibleColumns.some(c => c.id === 'graph');

  const formatDate = (timestamp: number) => timestamp ? formatCommitDate(timestamp, ROW_DATE, 'en') : '';

  return <div className="history-body" style={{
    '--ref-width': `${widths.refs}px`,
    '--graph-width': `${graphWidth}px`,
    '--message-width': `${widths.message}px`,
    '--author-width': `${widths.author}px`,
    '--hash-width': `${widths.hash}px`,
    '--date-width': `${widths.date}px`,
    '--history-total-width': `${totalWidth}px`,
  } as React.CSSProperties}>
    <div className="history-column-viewport">
      <div className="history-columns" style={{ transform: `translateX(${-scrollLeft}px)`, gridTemplateColumns }}>
        {visibleColumns.map(({ id }) => <span key={id} className={id === 'author' || id === 'hash' || id === 'date' ? `${id}-column` : undefined}>{COLUMN_LABELS[id]}{resizeHandle(id)}</span>)}
      </div>
      <div className="history-column-settings-anchor">
        <button
          ref={columnSettingsButton}
          type="button"
          className="icon-button sm"
          aria-label="Customize columns"
          title="Customize columns"
          onClick={() => setMenuOpen(open => !open)}
        >
          <Icons.Settings size={14} />
        </button>
      </div>
    </div>
    {menuOpen && (
      <HistoryColumnMenu
        columns={columns}
        triggerRef={columnSettingsButton}
        onChange={nextCols => updateSettings({ historyColumns: nextCols })}
        onClose={() => setMenuOpen(false)}
      />
    )}
    <div className="graph-viewport">
      <div className="history-scroll" ref={scroller} role="listbox" aria-label="Commit history" aria-describedby={`${uid}-help`} tabIndex={0}
        aria-activedescendant={selectedIndex >= start && selectedIndex < end ? activeControlId ?? `${uid}-commit-${selectedId}` : undefined}
        onScroll={event => { setScrollTop(event.currentTarget.scrollTop); setScrollLeft(event.currentTarget.scrollLeft); }}
        onDragOver={event => { if (![REF_DRAG_TYPE, COMMIT_DRAG_TYPE].some(type => event.dataTransfer.types.includes(type))) return; const bounds = event.currentTarget.getBoundingClientRect(); dragVelocity.current = event.clientY < bounds.top + 45 ? -10 : event.clientY > bounds.bottom - 45 ? 10 : 0; if (!dragFrame.current) autoScroll(); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stopDrag(); }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          const rowElement = scroller.current?.querySelector(`[id="${uid}-commit-${selectedId}"]`);
          const controls = rowElement ? [...rowElement.querySelectorAll<HTMLElement>('[data-row-control]')] : [];
          const active = activeN === null ? null : controls[activeN] ?? null;
          if (event.key === 'Escape' && active) { event.preventDefault(); event.stopPropagation(); setActiveControl(null); return; }
          if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !event.altKey && !event.ctrlKey && !event.metaKey && controls.length) {
            event.preventDefault();
            // Cycle: row itself -> each control -> row itself.
            let next = (activeN ?? -1) + (event.key === 'ArrowRight' ? 1 : -1);
            if (next >= controls.length) next = -1; else if (next < -1) next = controls.length - 1;
            setActiveControl(next < 0 ? null : { id: selectedId, n: next });
            return;
          }
          if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && active?.classList.contains('ref-pill')) {
            event.preventDefault();
            active.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, shiftKey: event.shiftKey, bubbles: true, cancelable: true }));
            return;
          }
          if ((event.key === 'Enter' || event.key === ' ') && active) { event.preventDefault(); active.click(); return; }
          if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && selectedId !== WORKING_ID && onContextActions) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); onContextActions({ oid: selectedId }, rect.left + 24, rect.top + 24, event.currentTarget); }
          const moves: Record<string, number> = { ArrowDown: selectedIndex + 1, ArrowUp: selectedIndex - 1, Home: 0, End: loaded - 1, PageDown: selectedIndex + Math.floor(height / rowHeight), PageUp: selectedIndex - Math.floor(height / rowHeight) };
          if (event.key in moves) { event.preventDefault(); setActiveControl(null); navigate(moves[event.key]); }
          if (event.key === 'Enter') { event.preventDefault(); onOpenDetails(); }
        }}>
        <div className="history-spacer" style={{ height: loaded * rowHeight }}
          // Apple: the hover fill sits under the graph canvas like the selection, so lines and dots stay crisp. Moved directly, no re-render per row.
          onMouseMove={apple ? event => { const el = hoverRect.current; if (!el) return; const row = Math.floor((event.clientY - event.currentTarget.getBoundingClientRect().top) / rowHeight); el.hidden = row < 0 || row >= loaded; el.style.top = `${row * rowHeight}px`; } : undefined}
          onMouseLeave={apple ? () => { if (hoverRect.current) hoverRect.current.hidden = true; } : undefined}>
          {apple && <div ref={hoverRect} className="history-hover" aria-hidden="true" hidden style={{ height: rowHeight - 2, left: 10, right: 10 }} />}
          {/* Apple design: the reference draws one rounded blue rect behind the selected row, spanning the whole row. */}
          {apple && selectedIndex >= 0 && <div className="history-selection" aria-hidden="true" style={{ top: selectedIndex * rowHeight, height: rowHeight - 2, left: 10, right: 10 }} />}
          {isGraphVisible && <canvas ref={canvas} className="graph-canvas" aria-hidden="true" data-layout-rows={layout.nodes.length} style={{ width: graphWidth, height: windowHeight, left: graphOffset, top: windowTop }} />}
          {commits.slice(start, end).map((commit, offset) => {
            const row = start + offset;
            const node = layout.nodes[row];
            const lane = node?.lane ?? 0;
            const branchColor = palette[branchColors.rows[row] ?? lane % colors.length];
            const badges = refsByCommit.get(commit.id) ?? NO_REFS;
            // refs/stash points at the stash commit, not at the index/tree helper commits it parents.
            const stash = badges.find(ref => ref.kind === 'stash');
            const groups = groupRefs(badges, headRef);
            const controls: RowControls = { n: 0 };
            return <div key={commit.id} id={`${uid}-commit-${commit.id}`} role="option" aria-selected={commit.id === selectedId}
              aria-posinset={row + 1} aria-setsize={commits.length}
              aria-label={`${commit.subject}, ${commit.author}, ${commit.id.slice(0, 7)}${commit.parents.length > 1 && !stash ? ', merge commit' : ''}${commit.id === head ? ', HEAD' : ''}${badges.length ? `, ${badges.map(b => b.name).join(', ')}` : ''}`}
              className={`commit-row ${commit.id === selectedId ? 'selected' : ''} ${shown && !shown.has(commit.id) ? 'dimmed' : ''} ${freshIds.has(commit.id) ? 'fresh' : ''} ${commit.id === WORKING_ID ? 'working' : ''} ${stash ? 'stash-commit' : ''} ${joinRefs && badges.length ? 'connect' : ''} ${row > 0 && dayStarts.starts.has(row) ? 'day-start' : ''}`}
              style={{
                top: row * rowHeight,
                height: rowHeight,
                gridTemplateColumns,
                '--branch-color': branchColor,
               } as React.CSSProperties} onContextMenu={event => { if (onContextActions && commit.id !== WORKING_ID) { event.preventDefault(); onContextActions({ oid: commit.id }, event.clientX, event.clientY, scroller.current ?? event.currentTarget); } }} onClick={() => { onSelect(commit.id); scroller.current?.focus(); }} onDoubleClick={onOpenDetails}>
              {visibleColumns.map(col => {
                if (col.id === 'refs') {
                  return <div key="refs" className="commit-refs">
                    {groups[0] && renderRef(groups[0], commit, controls)}
                    {groups.length > 1 && <button type="button" className="ref-more" tabIndex={-1} aria-label={`${groups.length - 1} more ref${groups.length > 2 ? 's' : ''}`} onClick={event => event.stopPropagation()}>+{groups.length - 1}</button>}
                    {groups.length > 1 && <div className="ref-stack">{groups.slice(1).map(group => renderRef(group, commit, controls))}</div>}
                  </div>;
                }
                if (col.id === 'graph') {
                  return <div key="graph" className="commit-graph-cell" aria-hidden="true">
                    {avatars && node && commit.id !== WORKING_ID && !(material && commit.parents.length > 1 && !stash) && <span className={`graph-avatar-node${commit.parents.length > 1 && !stash ? ' merge' : ''}`} data-shape={shapeOf(commit.author)} style={{ left: graphLaneX(node.lane) - graphX }}>
                      <AuthorAvatar name={commit.author} email={commit.email} mode={settings.authorAvatarMode} tiny />
                    </span>}
                  </div>;
                }
                if (col.id === 'message') {
                  const day = row > 0 ? dayStarts.starts.get(row) : undefined;
                  return <div key="message" className="commit-message">
                    {day && <span className="day-label" aria-hidden="true">{day.label}<i>{dayStarts.counts.get(day.key)}</i></span>}
                    {onTogglePick && commit.id !== WORKING_ID && (() => { const control = rowControl(commit.id, controls); return <input id={control.id} data-row-control="" tabIndex={-1} className={`graph-pick${control.active ? ' row-control-active' : ''}`} type="checkbox" aria-label={`Cherry-pick ${commit.id.slice(0, 7)}`} checked={pickOrder?.includes(commit.id) ?? false} onClick={event => event.stopPropagation()} onChange={() => { onTogglePick(commit.id); scroller.current?.focus(); }} />; })()}
                    {commit.parents.length > 1 && !stash && <Icons.GitMerge size={13} className="merge-icon" />}
                    <span className="subject" title={commit.subject} draggable={!!onActions && commit.id !== WORKING_ID}
                      onDragStart={event => { event.stopPropagation(); if (!onActions || commit.id === WORKING_ID) { event.preventDefault(); return; } event.dataTransfer.clearData(REF_DRAG_TYPE); event.dataTransfer.setData(COMMIT_DRAG_TYPE, commit.id); event.dataTransfer.effectAllowed = 'copy'; }} onDragEnd={stopDrag}>{stash ? commit.subject.replace(/^On .*?: /, '') : commit.subject}</span>
                    {onActions && commit.id !== WORKING_ID && (() => { const control = rowControl(commit.id, controls); return <button id={control.id} data-row-control="" tabIndex={-1} className={`icon-button sm graph-action-button${control.active ? ' row-control-active' : ''}`} aria-label={`Actions for ${commit.id.slice(0, 7)}`} onClick={event => { event.stopPropagation(); scroller.current?.focus(); onActions({ oid: commit.id }); }}>…</button>; })()}
                    {hasMore !== undefined && commit.parents.some(parent => !loadedIds.has(parent)) && !stash && <span className="boundary-label">{hasMore ? 'unloaded parent' : shallow ? 'shallow boundary' : 'unavailable parent'}</span>}
                  </div>;
                }
                if (col.id === 'author') {
                  return <span key="author" className="row-author author-column"><AuthorAvatar name={commit.author} email={commit.email} mode={settings.authorAvatarMode} tiny /><span>{commit.author.split(' ')[0]}</span></span>;
                }
                if (col.id === 'hash') {
                  return <span key="hash" className="row-hash hash-column">{commit.id === WORKING_ID ? 'Working' : commit.id.slice(0, 7)}</span>;
                }
                if (col.id === 'date') {
                  return <span key="date" className="row-date date-column" title={commit.timestamp ? commitIsoString(commit.timestamp) : ''}>{formatDate(commit.timestamp)}</span>;
                }
                return null;
              })}
            </div>;
          })}
        </div>
      </div>
      {isGraphVisible && graphScrollMax > 0 && <div ref={graphScroller} className="graph-hscroll" aria-label="Scroll graph horizontally" style={{ width: graphWidth, left: graphOffset - scrollLeft, bottom: hbar }} onScroll={event => setGraphScroll(event.currentTarget.scrollLeft)}><div style={{ width: graphContent }} /></div>}
    </div>
    <div className="history-bottom"><span><span className="live-dot" />{(loaded - (commits[0]?.id === WORKING_ID ? 1 : 0)).toLocaleString()} commits loaded{shallow ? ' · Shallow repository boundary' : ''}</span>
      {hasMore ? <button className="text-button" disabled={paging} onClick={onLoadMore}>{paging ? 'Loading…' : 'Load older history ↓'}</button> : <span className="muted">{shallow ? 'Available history loaded' : 'All history loaded'}</span>}
    </div>
    <span id={`${uid}-help`} className="sr-only">Use Up and Down to select commits, Page Up and Page Down to move a page, Home and End to move to the loaded boundaries. Press Enter to open details. Press Right or Left Arrow to move through the selected commit’s branch badges and controls, Enter or Space to activate the highlighted control, and Escape to return to the commit.{onActions && ' Press Shift+F10 for commit actions, or on a highlighted branch badge for branch actions.'}{onSwitchBranch && ' Double-click a local or origin branch badge to switch branches, creating a local tracking branch if needed.'}</span>
  </div>;
});
