import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, GitMerge, Tag } from 'lucide-react';
import { indexEdges, laneX, LANE_WIDTH, ROW_HEIGHT, type GraphLayout } from '../graph/layout';
import { WORKING_ID } from '../model/native';
import type { Commit, GitRef } from '../model/types';
import type { ActionContext } from './OperationDialog';
import type { ThemeDefinition } from '../model/settings';

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
  pickOrder?: string[];
  onTogglePick?: (oid: string) => void;
}

export const HistoryGraph = forwardRef<GraphHandle, Props>(function HistoryGraph({ commits, layout, refs, selectedId, head, loaded, matches, onSelect, onLoadMore, onOpenDetails, theme, hasMore, paging, shallow, headRef, onActions, pickOrder, onTogglePick }, ref) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const dragFrame = useRef(0);
  const dragVelocity = useRef(0);
  function stopDrag() { cancelAnimationFrame(dragFrame.current); dragFrame.current = 0; dragVelocity.current = 0; }
  function autoScroll() {
    if (scroller.current && dragVelocity.current) { scroller.current.scrollTop += dragVelocity.current; setScrollTop(scroller.current.scrollTop); dragFrame.current = requestAnimationFrame(autoScroll); }
    else dragFrame.current = 0;
  }
  useEffect(() => { window.addEventListener('dragend', stopDrag); window.addEventListener('drop', stopDrag, true); return () => { stopDrag(); window.removeEventListener('dragend', stopDrag); window.removeEventListener('drop', stopDrag, true); }; }, []);
  const graphWidth = Math.max(112, layout.laneCount * LANE_WIDTH + 32);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8);
  const end = Math.min(loaded, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 8);
  const selectedIndex = commits.findIndex(commit => commit.id === selectedId);
  const loadedIds = useMemo(() => new Set(commits.slice(0, loaded).map(commit => commit.id)), [commits, loaded]);
  const visibleEdges = useMemo(() => indexEdges(layout.edges), [layout.edges]);

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
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const colors = Array.from({ length: 8 }, (_, index) => theme.colors[`graphLane${index + 1}`]);
    const dpr = window.devicePixelRatio || 1;
    element.width = graphWidth * dpr;
    element.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, graphWidth, height);
    const y = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    for (const edge of visibleEdges(Math.floor(scrollTop / ROW_HEIGHT) - 1, Math.min(loaded, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 1))) {
      const x1 = laneX(edge.fromLane), xt = laneX(edge.track), x2 = laneX(edge.toLane);
      const y1 = y(edge.fromRow), y2 = y(edge.toRow);
      ctx.strokeStyle = colors[edge.track % colors.length];
      ctx.globalAlpha = matches ? 0.33 : 0.72;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1, y1 + 12, xt, y1 + 12, xt, y1 + 20);
      ctx.lineTo(xt, y2 - 20);
      ctx.bezierCurveTo(xt, y2 - 12, x2, y2 - 12, x2, y2);
      ctx.stroke();
    }
    for (let row = start; row < end; row++) {
      const node = layout.nodes[row];
      const commit = commits[row];
      const x = laneX(node.lane), cy = y(row);
      const selected = node.id === selectedId;
      ctx.globalAlpha = matches && !matches.has(node.id) ? 0.3 : 1;
      if (selected) {
        ctx.beginPath(); ctx.arc(x, cy, 9, 0, Math.PI * 2);
        ctx.fillStyle = theme.colors.graphSelection; ctx.fill();
      }
      ctx.beginPath();
      if (commit.id === WORKING_ID) ctx.rect(x - 4, cy - 4, 8, 8);
      else ctx.arc(x, cy, commit.parents.length > 1 ? 4.6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = commit.parents.length > 1 ? theme.colors.graphMerge : colors[node.lane % colors.length];
      ctx.fill(); ctx.strokeStyle = colors[node.lane % colors.length]; ctx.lineWidth = 1.8; ctx.stroke();
      if (node.id === head) {
        ctx.beginPath(); ctx.arc(x, cy, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = theme.colors.graphHead; ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }, [commits, layout, visibleEdges, start, end, scrollTop, height, graphWidth, selectedId, head, theme, matches, loaded]);

  function navigate(row: number) {
    if (!loaded) return;
    const next = Math.max(0, Math.min(loaded - 1, row));
    onSelect(commits[next].id);
    scrollTo(next);
  }

  return <div className="history-body" style={{ '--graph-width': `${graphWidth}px` } as React.CSSProperties}>
    <div className="history-columns" aria-hidden="true"><span>Graph</span><span>Commit message</span><span className="author-column">Author</span><span className="hash-column">Commit</span></div>
    <div className="graph-viewport">
      <div className="history-scroll" ref={scroller} role="listbox" aria-label="Commit history" aria-describedby="history-keyboard-help" tabIndex={0}
        aria-activedescendant={selectedIndex >= start && selectedIndex < end ? `commit-${selectedId}` : undefined}
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        onDragOver={event => { if (![REF_DRAG_TYPE, COMMIT_DRAG_TYPE].some(type => event.dataTransfer.types.includes(type))) return; const bounds = event.currentTarget.getBoundingClientRect(); dragVelocity.current = event.clientY < bounds.top + 45 ? -10 : event.clientY > bounds.bottom - 45 ? 10 : 0; if (!dragFrame.current) autoScroll(); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stopDrag(); }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && selectedId !== WORKING_ID) { event.preventDefault(); onActions?.({ oid: selectedId }); }
          const moves: Record<string, number> = { ArrowDown: selectedIndex + 1, ArrowUp: selectedIndex - 1, Home: 0, End: loaded - 1, PageDown: selectedIndex + Math.floor(height / ROW_HEIGHT), PageUp: selectedIndex - Math.floor(height / ROW_HEIGHT) };
          if (event.key in moves) { event.preventDefault(); navigate(moves[event.key]); }
          if (event.key === 'Enter') { event.preventDefault(); onOpenDetails(); }
        }}>
        <div className="history-spacer" style={{ height: loaded * ROW_HEIGHT }}>
          {commits.slice(start, end).map((commit, offset) => {
            const row = start + offset;
            const badges = refs.filter(ref => ref.commitId === commit.id && ref.kind !== 'remote');
            return <div key={commit.id} id={`commit-${commit.id}`} role="option" aria-selected={commit.id === selectedId}
              aria-posinset={row + 1} aria-setsize={commits.length}
              aria-label={`${commit.subject}, ${commit.author}, ${commit.id.slice(0, 7)}${commit.parents.length > 1 ? ', merge commit' : ''}${commit.id === head ? ', HEAD' : ''}${badges.length ? `, ${badges.map(b => b.name).join(', ')}` : ''}`}
              className={`commit-row ${commit.id === selectedId ? 'selected' : ''} ${matches && !matches.has(commit.id) ? 'dimmed' : ''}`}
              style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }} onContextMenu={event => { if (onActions && commit.id !== WORKING_ID) { event.preventDefault(); onActions({ oid: commit.id }); } }} onClick={() => { onSelect(commit.id); scroller.current?.focus(); }} onDoubleClick={onOpenDetails}>
              <div className="commit-message">
                {onTogglePick && commit.id !== WORKING_ID && <input className="graph-pick" type="checkbox" aria-label={`Cherry-pick ${commit.id.slice(0, 7)}`} checked={pickOrder?.includes(commit.id) ?? false} onClick={event => event.stopPropagation()} onChange={() => onTogglePick(commit.id)} />}
                {badges.map(ref => <span key={ref.fullName ?? ref.name} className={`ref-pill ${ref.kind === 'tag' ? 'tag-ref' : ref.name === 'main' ? 'main-ref' : ''}`}
                  role={onActions && ref.fullName ? 'button' : undefined} tabIndex={onActions && ref.fullName ? 0 : undefined} aria-label={onActions && ref.fullName ? `Graph actions for ${ref.name}` : undefined}
                  onKeyDown={event => { if (onActions && ref.fullName && (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) { event.preventDefault(); event.stopPropagation(); onActions({ oid: commit.id, ref: ref.fullName }); } }}
                  data-current={!!headRef && ref.fullName === headRef} draggable={!!onActions && !!ref.fullName && ref.kind !== 'tag'}
                  onDragStart={event => { event.stopPropagation(); if (onActions && ref.fullName && ref.kind !== 'tag') { event.dataTransfer.clearData(COMMIT_DRAG_TYPE); event.dataTransfer.setData(REF_DRAG_TYPE, ref.fullName); event.dataTransfer.effectAllowed = 'copy'; } else event.preventDefault(); }} onDragEnd={stopDrag}
                  onDragOver={event => { if (ref.fullName === headRef && [REF_DRAG_TYPE, COMMIT_DRAG_TYPE].some(type => event.dataTransfer.types.includes(type))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
                  onDrop={event => { event.preventDefault(); event.stopPropagation(); stopDrag(); const action = graphDropAction(event.dataTransfer, ref.fullName, headRef, commits.slice(0, loaded), refs); if (action) onActions?.(action); }}
                  onContextMenu={event => { if (onActions && ref.fullName) { event.preventDefault(); event.stopPropagation(); onActions({ oid: commit.id, ref: ref.fullName }); } }} onClick={event => { if (onActions && ref.fullName) { event.stopPropagation(); onActions({ oid: commit.id, ref: ref.fullName }); } }}>
                  {ref.kind === 'tag' ? <Tag size={10} /> : <GitBranch size={10} />}{ref.name}
                </span>)}
                {commit.parents.length > 1 && <GitMerge size={13} className="merge-icon" />}
                <span className="subject" title={commit.subject} draggable={!!onActions && commit.id !== WORKING_ID}
                  onDragStart={event => { event.stopPropagation(); if (!onActions || commit.id === WORKING_ID) { event.preventDefault(); return; } event.dataTransfer.clearData(REF_DRAG_TYPE); event.dataTransfer.setData(COMMIT_DRAG_TYPE, commit.id); event.dataTransfer.effectAllowed = 'copy'; }} onDragEnd={stopDrag}>{commit.subject}</span>
                {onActions && commit.id !== WORKING_ID && <button className="graph-action-button" aria-label={`Actions for ${commit.id.slice(0, 7)}`} onClick={event => { event.stopPropagation(); onActions({ oid: commit.id }); }}>…</button>}
                {hasMore !== undefined && commit.parents.some(parent => !loadedIds.has(parent)) && <span className="boundary-label">{hasMore ? 'unloaded parent' : shallow ? 'shallow boundary' : 'unavailable parent'}</span>}
              </div>
              <span className="row-author author-column"><span className={`avatar tiny color-${commit.author.charCodeAt(0) % 5}`}>{commit.author.split(' ').map(n => n[0]).join('')}</span><span>{commit.author.split(' ')[0]}</span></span>
              <span className="row-hash hash-column">{commit.id === WORKING_ID ? 'Working' : commit.id.slice(0, 7)}</span>
            </div>;
          })}
        </div>
      </div>
      <canvas ref={canvas} className="graph-canvas" aria-hidden="true" style={{ width: graphWidth, height }} />
    </div>
    <div className="history-bottom"><span><span className="live-dot" />{loaded.toLocaleString()} loaded{shallow ? ' · Shallow repository boundary' : ''}</span>
      {(hasMore ?? loaded < commits.length) ? <button className="text-button" disabled={paging} onClick={onLoadMore}>{paging ? 'Loading…' : 'Load older history ↓'}</button> : <span className="muted">{shallow ? 'Available history loaded' : 'All history loaded'}</span>}
    </div>
    <span id="history-keyboard-help" className="sr-only">Use Up and Down to select commits, Page Up and Page Down to move a page, Home and End to move to the loaded boundaries. Press Enter to open details.{onActions && ' Press Shift+F10 for commit actions. Tab to a branch badge and press Enter or Shift+F10 for branch actions.'}</span>
  </div>;
});
