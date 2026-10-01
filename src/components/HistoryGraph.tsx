import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GitMerge, Globe2, Laptop, Settings as SettingsIcon, Tag } from 'lucide-react';
import { indexEdges, laneX, LANE_WIDTH, ROW_HEIGHT, type GraphLayout } from '../graph/layout';
import { assignBranchColors, branchName } from '../graph/branchColor';
import { WORKING_ID } from '../model/native';
import type { Commit, GitRef } from '../model/types';
import type { ActionContext } from './OperationDialog';
import { DEFAULT_HISTORY_COLUMNS, useSettings, type HistoryColumnId, type ThemeDefinition } from '../model/settings';
import { HistoryColumnMenu } from './HistoryColumnMenu';
import { initials } from './ui';

export interface GraphAnchor { id: string; offset: number }
export interface GraphHandle { scrollTo: (row: number) => void; focus: () => void; anchor: () => GraphAnchor | null; restore: (anchor: GraphAnchor) => void }
export const REF_DRAG_TYPE = 'application/x-gitty-ref';
export const COMMIT_DRAG_TYPE = 'application/x-gitty-commit';
export function graphDropAction(data: DataTransfer, targetRef: string | undefined, headRef: string | null | undefined, commits: readonly { id: string }[], refs: readonly (GitRef & { fullName?: string })[]): ActionContext | null {
  if (!headRef || targetRef !== headRef || !refs.some(ref => ref.fullName === targetRef && ref.kind === 'local')) return null;
  const branchDrag = data.types.includes(REF_DRAG_TYPE), commitDrag = data.types.includes(COMMIT_DRAG_TYPE);
  if (branchDrag === commitDrag) return null;
  if (branchDrag) {
    const source = data.getData(REF_DRAG_TYPE);
    const actual = refs.find(ref => ref.fullName === source && ref.kind !== 'tag');
    return actual && source !== headRef ? { oid: actual.commitId, ref: source, initial: 'merge' } : null;
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
  loaded: number;
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
}

const MIN_GRAPH_WIDTH = laneX(2) + 14; // three lanes plus the selection halo; also fits the "GRAPH" label
export const HistoryGraph = forwardRef<GraphHandle, Props>(function HistoryGraph({ commits, layout, refs, selectedId, head, loaded, matches, onSelect, onLoadMore, onOpenDetails, theme, hasMore, paging, shallow, headRef, onActions, onContextActions, onSwitchBranch, pickOrder, onTogglePick }, ref) {
  const { settings, updateSettings } = useSettings();
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const columnSettingsButton = useRef<HTMLButtonElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [graphScroll, setGraphScroll] = useState(0);
  const [hbar, setHbar] = useState(0);
  const graphScroller = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(600);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [widths, setWidths] = useState<Record<HistoryColumnId, number>>({ refs: 170, graph: MIN_GRAPH_WIDTH, message: 130, author: 110, hash: 90, date: 120 });
  type Column = HistoryColumnId;
  const limits: Record<Column, [number, number]> = { refs: [90, 420], graph: [MIN_GRAPH_WIDTH, 600], message: [100, 600], author: [70, 260], hash: [70, 180], date: [80, 220] };
  function resize(column: Column, delta: number) {
    setWidths(current => ({ ...current, [column]: Math.max(limits[column][0], Math.min(limits[column][1], current[column] + delta)) }));
  }
  function resizeHandle(column: Column) {
    const colLabels: Record<Column, string> = { refs: 'Branch / tag', graph: 'Graph', message: 'Commit message', author: 'Author', hash: 'Commit', date: 'Date' };
    return <button className="history-column-resize" aria-label={`Resize ${colLabels[column]} column`} title="Drag or use arrow keys to resize" onClick={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(column, event.key === 'ArrowRight' ? 10 : -10); } }}
      onPointerDown={event => {
        event.preventDefault();
        const target = event.currentTarget, start = event.clientX, initial = widths[column];
        target.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => setWidths(current => ({ ...current, [column]: Math.max(limits[column][0], Math.min(limits[column][1], initial + moveEvent.clientX - start)) }));
        const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end); };
        target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
      }} />;
  }
  const dragFrame = useRef(0);
  const badgeAction = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragVelocity = useRef(0);
  function stopDrag() { cancelAnimationFrame(dragFrame.current); dragFrame.current = 0; dragVelocity.current = 0; }
  function autoScroll() {
    if (scroller.current && dragVelocity.current) { scroller.current.scrollTop += dragVelocity.current; setScrollTop(scroller.current.scrollTop); dragFrame.current = requestAnimationFrame(autoScroll); }
    else dragFrame.current = 0;
  }
  useEffect(() => { window.addEventListener('dragend', stopDrag); window.addEventListener('drop', stopDrag, true); return () => { stopDrag(); if (badgeAction.current) clearTimeout(badgeAction.current); window.removeEventListener('dragend', stopDrag); window.removeEventListener('drop', stopDrag, true); }; }, []);
  // The column keeps its own width however wide the lane tree gets; the canvas shows a window scrolled by graphScroll.
  const graphContent = Math.max(112, layout.laneCount * LANE_WIDTH + 32);
  const graphWidth = widths.graph;
  const graphScrollMax = Math.max(0, graphContent - graphWidth);
  const graphX = Math.min(graphScroll, graphScrollMax);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8);
  const end = Math.min(loaded, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 8);
  const selectedIndex = commits.findIndex(commit => commit.id === selectedId);
  const loadedIds = useMemo(() => new Set(commits.slice(0, loaded).map(commit => commit.id)), [commits, loaded]);
  const visibleEdges = useMemo(() => indexEdges(layout.edges, layout.edgeMaxTo), [layout.edges, layout.edgeMaxTo]);
  const colors = useMemo(() => Array.from({ length: 8 }, (_, index) => theme.colors[`graphLane${index + 1}`]), [theme]);
  const palette = useMemo(() => [...colors, theme.colors.accent], [colors, theme]);
  const currentBranch = headRef?.startsWith('refs/heads/') ? headRef.slice(11) : null;
  const branchColors = useMemo(() => assignBranchColors(commits, refs, WORKING_ID, currentBranch), [commits, refs, currentBranch]);

  function renderRef({ ref, remote }: { ref: GitRef & { fullName?: string }; remote?: GitRef }, commit: Commit) {
    const name = branchName(ref);
    return <span key={ref.fullName ?? ref.name} className={`ref-pill ${ref.kind === 'tag' ? 'tag-ref' : ref.kind === 'remote' ? 'remote-ref' : ''}`}
                      style={name !== null ? { '--branch-color': palette[branchColors.branches.get(name)!] } as React.CSSProperties : undefined}
                      data-name={ref.name} title={remote ? `${ref.name} + ${remote.name}` : ref.name}
                      role={onActions && ref.fullName ? 'button' : undefined} tabIndex={onActions && ref.fullName ? 0 : undefined} aria-label={onActions && ref.fullName ? `Graph actions for ${ref.name}` : undefined}
                      onKeyDown={event => { if (!ref.fullName) return; if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && onContextActions) { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onContextActions({ oid: commit.id, ref: ref.fullName }, rect.left, rect.bottom, event.currentTarget); } else if (onActions && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); onActions({ oid: commit.id, ref: ref.fullName }); } }}
                      data-current={!!headRef && ref.fullName === headRef} draggable={!!onActions && !!ref.fullName && ref.kind !== 'tag'}
                      onDragStart={event => { event.stopPropagation(); if (onActions && ref.fullName && ref.kind !== 'tag') { event.dataTransfer.clearData(COMMIT_DRAG_TYPE); event.dataTransfer.setData(REF_DRAG_TYPE, ref.fullName); event.dataTransfer.effectAllowed = 'copy'; } else event.preventDefault(); }} onDragEnd={stopDrag}
                      onDragOver={event => { if (ref.fullName === headRef && [REF_DRAG_TYPE, COMMIT_DRAG_TYPE].some(type => event.dataTransfer.types.includes(type))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
                      onDrop={event => { event.preventDefault(); event.stopPropagation(); stopDrag(); const action = graphDropAction(event.dataTransfer, ref.fullName, headRef, commits.slice(0, loaded), refs); if (action) onActions?.(action); }}
                      onContextMenu={event => { if (onContextActions && ref.fullName) { event.preventDefault(); event.stopPropagation(); onContextActions({ oid: commit.id, ref: ref.fullName }, event.clientX, event.clientY, event.currentTarget); } }} onClick={event => { if (onActions && ref.fullName) { event.stopPropagation(); if (ref.kind === 'local' && onSwitchBranch) { if (badgeAction.current) clearTimeout(badgeAction.current); if (event.detail < 2) badgeAction.current = setTimeout(() => { badgeAction.current = null; onActions({ oid: commit.id, ref: ref.fullName }); }, 500); } else onActions({ oid: commit.id, ref: ref.fullName }); } }}
                      onDoubleClick={event => { if (ref.kind === 'local' && ref.fullName && onSwitchBranch) { event.stopPropagation(); if (badgeAction.current) clearTimeout(badgeAction.current); badgeAction.current = null; onSwitchBranch(ref.fullName); } }}>
                      {ref.kind === 'tag' ? <Tag size={10} /> : ref.kind === 'remote' ? <Globe2 size={10} /> : <Laptop size={10} />}{remote && <Globe2 size={10} />}<span className="ref-pill-name">{ref.name}</span>
                    </span>;
  }

  function scrollTo(row: number) {
    const el = scroller.current;
    if (!el) return;
    const top = row * ROW_HEIGHT;
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
      setScrollTop(el.scrollTop);
    }
  }
  useImperativeHandle(ref, () => ({ scrollTo, focus: () => scroller.current?.focus(), anchor: () => {
    const top = scroller.current?.scrollTop ?? 0;
    const commit = commits[Math.floor(top / ROW_HEIGHT)];
    return commit ? { id: commit.id, offset: top % ROW_HEIGHT } : null;
  }, restore: anchor => {
    const row = commits.findIndex(commit => commit.id === anchor.id);
    if (row >= 0 && scroller.current) { scroller.current.scrollTop = row * ROW_HEIGHT + anchor.offset; setScrollTop(scroller.current.scrollTop); }
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

  // Selection halo glides between rows instead of snapping (skipped under reduced motion).
  const halo = useRef<{ id: string; from: [number, number]; to: [number, number]; start: number } | null>(null);
  const haloFrame = useRef(0);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    element.width = graphWidth * dpr;
    element.height = height * dpr;
    const y = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    const selectedRow = commits.findIndex(commit => commit.id === selectedId);
    const target: [number, number] | null = selectedRow >= 0 && layout.nodes[selectedRow] ? [laneX(layout.nodes[selectedRow].lane), selectedRow] : null;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const ease = (t: number) => 1 - (1 - t) ** 3;
    const haloAt = (now: number): [number, number] | null => {
      const h = halo.current;
      if (!h || !target) return target;
      const t = Math.min(1, (now - h.start) / 180);
      return [h.from[0] + (h.to[0] - h.from[0]) * ease(t), h.from[1] + (h.to[1] - h.from[1]) * ease(t)];
    };
    if (target && halo.current?.id !== selectedId) {
      const previous = halo.current ? haloAt(performance.now()) : null;
      const from = !reduce && previous && Math.abs(previous[1] - target[1]) < 24 ? previous : target;
      halo.current = { id: selectedId, from, to: target, start: performance.now() };
    } else if (target && halo.current) halo.current.to = target;
    const bg = theme.colors.bg;
    const paint = () => {
      const now = performance.now();
      ctx.setTransform(dpr, 0, 0, dpr, -graphX * dpr, 0);
      ctx.clearRect(graphX, 0, graphWidth, height);
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      for (const edge of visibleEdges(Math.floor(scrollTop / ROW_HEIGHT) - 1, Math.min(loaded, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 1))) {
        const x1 = laneX(edge.fromLane), xt = laneX(edge.track), x2 = laneX(edge.toLane);
        const y1 = y(edge.fromRow), y2 = y(edge.toRow);
        const colorRow = commits[edge.fromRow]?.parents[0] === edge.to ? edge.fromRow : edge.toRow;
        ctx.strokeStyle = palette[branchColors.rows[colorRow] ?? branchColors.rows[edge.fromRow] ?? edge.track % colors.length];
        ctx.globalAlpha = matches ? 0.3 : 0.78;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        const bend = ROW_HEIGHT / 4, reach = ROW_HEIGHT * 5 / 12;
        ctx.bezierCurveTo(x1, y1 + bend, xt, y1 + bend, xt, y1 + reach);
        ctx.lineTo(xt, y2 - reach);
        ctx.bezierCurveTo(xt, y2 - bend, x2, y2 - bend, x2, y2);
        ctx.stroke();
      }
      const at = haloAt(now);
      if (at) {
        ctx.globalAlpha = 0.22;
        ctx.beginPath(); ctx.arc(at[0], at[1] * ROW_HEIGHT + ROW_HEIGHT / 2 - scrollTop, 11, 0, Math.PI * 2);
        ctx.fillStyle = theme.colors.graphSelection; ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.strokeStyle = theme.colors.graphSelection; ctx.stroke();
      }
      // The worker can still be laying out newly loaded history when this effect
      // runs. Rows remain visible, but their canvas nodes must wait for layout.
      for (let row = start; row < Math.min(end, layout.nodes.length, commits.length); row++) {
        const node = layout.nodes[row];
        const commit = commits[row];
        const x = laneX(node.lane), cy = y(row);
        const lane = palette[branchColors.rows[row] ?? node.lane % colors.length];
        ctx.globalAlpha = matches && !matches.has(node.id) ? 0.3 : 1;
        ctx.beginPath();
        if (commit.id === WORKING_ID) ctx.roundRect(x - 5, cy - 5, 10, 10, 2.5);
        else ctx.arc(x, cy, commit.parents.length > 1 ? 5.5 : 5, 0, Math.PI * 2);
        // Merges and the working tree are hollow rings; ordinary commits are solid with a background gap ring.
        const hollow = commit.parents.length > 1 || commit.id === WORKING_ID;
        ctx.fillStyle = hollow ? bg : lane; ctx.fill();
        ctx.lineWidth = hollow ? 2 : 2.5; ctx.strokeStyle = hollow ? lane : bg; ctx.stroke();
        if (!hollow) { ctx.beginPath(); ctx.arc(x, cy, 5, 0, Math.PI * 2); ctx.lineWidth = 1; ctx.strokeStyle = lane; ctx.stroke(); }
        if (node.id === head) {
          ctx.beginPath(); ctx.arc(x, cy, 2, 0, Math.PI * 2);
          ctx.fillStyle = hollow ? theme.colors.graphHead : bg; ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      const h = halo.current;
      haloFrame.current = h && now - h.start < 180 ? requestAnimationFrame(paint) : 0;
    };
    paint();
    return () => cancelAnimationFrame(haloFrame.current);
  }, [commits, layout, visibleEdges, start, end, scrollTop, height, graphWidth, graphX, selectedId, head, theme, matches, loaded, colors, palette, branchColors]);

  useEffect(() => {
    const node = layout.nodes[selectedIndex];
    const el = graphScroller.current;
    if (!node || !el) return;
    const x = laneX(node.lane);
    if (x < graphX + 12) el.scrollLeft = Math.max(0, x - 24);
    else if (x > graphX + graphWidth - 12) el.scrollLeft = x - graphWidth + 24;
  }, [selectedIndex, layout.nodes]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const columns = settings.historyColumns ?? DEFAULT_HISTORY_COLUMNS;
  const visibleColumns = useMemo(() => columns.filter(c => c.visible), [columns]);

  const columnWidth = (id: Column) => (id === 'graph' ? graphWidth : widths[id]);

  const gridTemplateColumns = useMemo(
    () =>
      visibleColumns
        .map(c => {
          if (c.id === 'refs') return 'var(--ref-width)';
          if (c.id === 'graph') return 'var(--graph-width)';
          if (c.id === 'message') return 'minmax(var(--message-width), 1fr)';
          if (c.id === 'author') return 'var(--author-width)';
          if (c.id === 'hash') return 'var(--hash-width)';
          return 'var(--date-width)';
        })
        .join(' '),
    [visibleColumns]
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
      if (col.id === 'message') offset += Math.max(0, viewportWidth - totalWidth);
    }
    return offset;
  }, [visibleColumns, widths, graphWidth, viewportWidth, totalWidth]);

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

  const formatDate = (timestamp: number) => {
    if (!timestamp) return '';
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(timestamp < 1e11 ? timestamp * 1000 : timestamp);
  };

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
        {visibleColumns.map(col => {
          if (col.id === 'refs') return <span key="refs">Branch / tag{resizeHandle('refs')}</span>;
          if (col.id === 'graph') return <span key="graph">Graph{resizeHandle('graph')}</span>;
          if (col.id === 'message') return <span key="message">Commit message{resizeHandle('message')}</span>;
          if (col.id === 'author') return <span key="author" className="author-column">Author{resizeHandle('author')}</span>;
          if (col.id === 'hash') return <span key="hash" className="hash-column">Commit{resizeHandle('hash')}</span>;
          if (col.id === 'date') return <span key="date" className="date-column">Date{resizeHandle('date')}</span>;
          return null;
        })}
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
          <SettingsIcon size={14} />
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
      <div className="history-scroll" ref={scroller} role="listbox" aria-label="Commit history" aria-describedby="history-keyboard-help" tabIndex={0}
        aria-activedescendant={selectedIndex >= start && selectedIndex < end ? `commit-${selectedId}` : undefined}
        onScroll={event => { setScrollTop(event.currentTarget.scrollTop); setScrollLeft(event.currentTarget.scrollLeft); }}
        onDragOver={event => { if (![REF_DRAG_TYPE, COMMIT_DRAG_TYPE].some(type => event.dataTransfer.types.includes(type))) return; const bounds = event.currentTarget.getBoundingClientRect(); dragVelocity.current = event.clientY < bounds.top + 45 ? -10 : event.clientY > bounds.bottom - 45 ? 10 : 0; if (!dragFrame.current) autoScroll(); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stopDrag(); }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && selectedId !== WORKING_ID && onContextActions) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); onContextActions({ oid: selectedId }, rect.left + 24, rect.top + 24, event.currentTarget); }
          const moves: Record<string, number> = { ArrowDown: selectedIndex + 1, ArrowUp: selectedIndex - 1, Home: 0, End: loaded - 1, PageDown: selectedIndex + Math.floor(height / ROW_HEIGHT), PageUp: selectedIndex - Math.floor(height / ROW_HEIGHT) };
          if (event.key in moves) { event.preventDefault(); navigate(moves[event.key]); }
          if (event.key === 'Enter') { event.preventDefault(); onOpenDetails(); }
        }}>
        <div className="history-spacer" style={{ height: loaded * ROW_HEIGHT }}>
          {commits.slice(start, end).map((commit, offset) => {
            const row = start + offset;
            const node = layout.nodes[row];
            const lane = node?.lane ?? 0;
            const branchColor = palette[branchColors.rows[row] ?? lane % colors.length];
            const badges = refs.filter(ref => ref.commitId === commit.id && !(ref.kind === 'remote' && ref.name.endsWith('/HEAD')));
            const groups = groupRefs(badges, headRef);
            return <div key={commit.id} id={`commit-${commit.id}`} role="option" aria-selected={commit.id === selectedId}
              aria-posinset={row + 1} aria-setsize={commits.length}
              aria-label={`${commit.subject}, ${commit.author}, ${commit.id.slice(0, 7)}${commit.parents.length > 1 ? ', merge commit' : ''}${commit.id === head ? ', HEAD' : ''}${badges.length ? `, ${badges.map(b => b.name).join(', ')}` : ''}`}
              className={`commit-row ${commit.id === selectedId ? 'selected' : ''} ${matches && !matches.has(commit.id) ? 'dimmed' : ''} ${freshIds.has(commit.id) ? 'fresh' : ''}`}
              style={{
                top: row * ROW_HEIGHT,
                height: ROW_HEIGHT,
                gridTemplateColumns,
                '--branch-color': branchColor,
               } as React.CSSProperties} onContextMenu={event => { if (onContextActions && commit.id !== WORKING_ID) { event.preventDefault(); onContextActions({ oid: commit.id }, event.clientX, event.clientY, scroller.current ?? event.currentTarget); } }} onClick={() => { onSelect(commit.id); scroller.current?.focus(); }} onDoubleClick={onOpenDetails}>
              {visibleColumns.map(col => {
                if (col.id === 'refs') {
                  return <div key="refs" className="commit-refs">
                    {groups[0] && renderRef(groups[0], commit)}
                    {groups.length > 1 && <button type="button" className="ref-more" aria-label={`${groups.length - 1} more ref${groups.length > 2 ? 's' : ''}`} onClick={event => event.stopPropagation()}>+{groups.length - 1}</button>}
                    {groups.length > 1 && <div className="ref-stack">{groups.slice(1).map(group => renderRef(group, commit))}</div>}
                  </div>;
                }
                if (col.id === 'graph') {
                  return <div key="graph" className="commit-graph-cell" aria-hidden="true">{commit.id === head && <span className="graph-head-pulse" style={{ left: laneX(lane) - graphX }} />}</div>;
                }
                if (col.id === 'message') {
                  return <div key="message" className="commit-message">
                    {onTogglePick && commit.id !== WORKING_ID && <input className="graph-pick" type="checkbox" aria-label={`Cherry-pick ${commit.id.slice(0, 7)}`} checked={pickOrder?.includes(commit.id) ?? false} onClick={event => event.stopPropagation()} onChange={() => onTogglePick(commit.id)} />}
                    {commit.parents.length > 1 && <GitMerge size={13} className="merge-icon" />}
                    <span className="subject" title={commit.subject} draggable={!!onActions && commit.id !== WORKING_ID}
                      onDragStart={event => { event.stopPropagation(); if (!onActions || commit.id === WORKING_ID) { event.preventDefault(); return; } event.dataTransfer.clearData(REF_DRAG_TYPE); event.dataTransfer.setData(COMMIT_DRAG_TYPE, commit.id); event.dataTransfer.effectAllowed = 'copy'; }} onDragEnd={stopDrag}>{commit.subject}</span>
                    {onActions && commit.id !== WORKING_ID && <button className="icon-button sm graph-action-button" aria-label={`Actions for ${commit.id.slice(0, 7)}`} onClick={event => { event.stopPropagation(); onActions({ oid: commit.id }); }}>…</button>}
                    {hasMore !== undefined && commit.parents.some(parent => !loadedIds.has(parent)) && <span className="boundary-label">{hasMore ? 'unloaded parent' : shallow ? 'shallow boundary' : 'unavailable parent'}</span>}
                  </div>;
                }
                if (col.id === 'author') {
                  return <span key="author" className="row-author author-column"><span className="avatar tiny">{initials(commit.author)}</span><span>{commit.author.split(' ')[0]}</span></span>;
                }
                if (col.id === 'hash') {
                  return <span key="hash" className="row-hash hash-column">{commit.id === WORKING_ID ? 'Working' : commit.id.slice(0, 7)}</span>;
                }
                if (col.id === 'date') {
                  return <span key="date" className="row-date date-column" title={commit.timestamp ? new Date(commit.timestamp < 1e11 ? commit.timestamp * 1000 : commit.timestamp).toISOString() : ''}>{formatDate(commit.timestamp)}</span>;
                }
                return null;
              })}
            </div>;
          })}
        </div>
      </div>
      {isGraphVisible && graphScrollMax > 0 && <div ref={graphScroller} className="graph-hscroll" aria-label="Scroll graph horizontally" style={{ width: graphWidth, left: graphOffset - scrollLeft, bottom: hbar }} onScroll={event => setGraphScroll(event.currentTarget.scrollLeft)}><div style={{ width: graphContent }} /></div>}
      {isGraphVisible && <canvas ref={canvas} className="graph-canvas" aria-hidden="true" style={{ width: graphWidth, height, left: graphOffset - scrollLeft }} />}
    </div>
    <div className="history-bottom"><span><span className="live-dot" />{(loaded - (commits[0]?.id === WORKING_ID ? 1 : 0)).toLocaleString()} commits loaded{shallow ? ' · Shallow repository boundary' : ''}</span>
      {(hasMore ?? loaded < commits.length) ? <button className="text-button" disabled={paging} onClick={onLoadMore}>{paging ? 'Loading…' : 'Load older history ↓'}</button> : <span className="muted">{shallow ? 'Available history loaded' : 'All history loaded'}</span>}
    </div>
    <span id="history-keyboard-help" className="sr-only">Use Up and Down to select commits, Page Up and Page Down to move a page, Home and End to move to the loaded boundaries. Press Enter to open details.{onActions && ' Press Shift+F10 for commit actions. Tab to a branch badge and press Enter or Shift+F10 for branch actions.'}{onSwitchBranch && ' Double-click a local branch badge to switch branches.'}</span>
  </div>;
});
