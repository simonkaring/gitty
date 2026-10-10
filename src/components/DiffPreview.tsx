import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import type { DiffLine, FileDiff, RepositoryMutation } from '../model/repository';
import { diffRows, rowAt, rowOffsets, visibleRows, type DiffRow, type SplitDiffLine, type SplitDiffRow } from '../model/splitDiff';

/** Diffs with more rows than this render a window of rows between spacers; smaller ones render every row. */
export const DIFF_VIRTUALIZE_ABOVE = 400;
/** Extra rows rendered above and below the viewport. */
export const DIFF_OVERSCAN = 30;
/** Height estimates (px) used until a row has been measured; measured averages replace them per row class. */
export const DIFF_ROW_ESTIMATE = { hunk: 32, unified: 22, split: 24 } as const;
const RANGE_STEP = 10;
const FALLBACK_VIEWPORT = 800;

type Side = 'before' | 'after';
interface Metrics {
  rows: DiffRow[];
  split: boolean;
  /** Measured border-box height per row; 0 means not measured yet. */
  heights: Float64Array;
  /** Running sums/counts of measured heights for [hunk headers, line rows]. */
  sums: [number, number];
  counts: [number, number];
  offsets: Float64Array;
  /** Distance from the scroller's content top to the first row (column header, messages). */
  rowsTop: number;
  /** Widest observed overflowing code/row width; never shrinks until the diff or editor preferences change. */
  widest: number;
  surfaceWidth: number;
}

const rowClass = (row: DiffRow) => row.kind === 'hunk' ? 0 : 1;
const wrapped = () => typeof document !== 'undefined' && document.documentElement.dataset.diffWrap === 'true';

function relayout(m: Metrics) {
  const defaults = [DIFF_ROW_ESTIMATE.hunk, m.split ? DIFF_ROW_ESTIMATE.split : DIFF_ROW_ESTIMATE.unified];
  const estimate = [0, 1].map(c => m.counts[c] ? m.sums[c] / m.counts[c] : defaults[c]);
  m.offsets = rowOffsets(m.rows.length, i => m.heights[i] || estimate[rowClass(m.rows[i])]);
}

function resetMetrics(m: Metrics, rows: DiffRow[], split: boolean) {
  m.rows = rows; m.split = split;
  m.heights = new Float64Array(rows.length);
  m.sums = [0, 0]; m.counts = [0, 0];
  m.widest = 0;
  relayout(m);
}

/** The element whose box is a row's height: split rows use `display: contents`, so measure their first cell. */
const rowBox = (element: Element) => (element.classList.contains('split-row') ? element.firstElementChild : element) as HTMLElement | null;

export function DiffPreview({
  diff,
  split,
  hunkAction,
  busy = false,
  unavailable,
  onHunk,
  selectedLines: controlledSelected,
  onToggleLine: controlledOnToggle,
}: {
  diff: FileDiff;
  split: boolean;
  hunkAction?: 'stage_hunk' | 'unstage_hunk';
  busy?: boolean;
  unavailable?: string;
  onHunk?: (mutation: RepositoryMutation) => void;
  selectedLines?: Record<number, number[]>;
  onToggleLine?: (hunkIndex: number, lineIndex: number) => void;
}) {
  const reason = hunkAction ? unavailable || (diff.truncated ? 'Hunk actions are unavailable for truncated previews. Use the whole-file buttons or Git.' : diff.binary ? 'Hunk actions are unavailable for binary files. Use the whole-file buttons.' : diff.hunkAction?.reason) || (!diff.hunkAction?.fingerprint ? 'Hunk actions are unavailable for this preview. Use the whole-file buttons or Git.' : undefined) : undefined;
  const fingerprint = !reason && diff.hunkAction?.fingerprint;

  const diffKey = `${diff.path}:${hunkAction ?? ''}:${fingerprint || ''}`;
  const [currentKey, setCurrentKey] = useState(diffKey);
  const [internalSelected, setInternalSelected] = useState<Record<number, number[]>>({});

  if (currentKey !== diffKey) {
    setCurrentKey(diffKey);
    setInternalSelected({});
  }

  const selected = controlledSelected ?? internalSelected;

  const toggleLine = (hunkIndex: number, lineIndex: number) => {
    if (busy || !fingerprint) return;
    if (controlledOnToggle) {
      controlledOnToggle(hunkIndex, lineIndex);
      return;
    }
    setInternalSelected(prev => {
      const current = prev[hunkIndex] ?? [];
      const next = current.includes(lineIndex)
        ? current.filter(i => i !== lineIndex)
        : [...current, lineIndex];
      return { ...prev, [hunkIndex]: next };
    });
  };

  const actionVerb = hunkAction === 'unstage_hunk' ? 'unstaging' : 'staging';
  const lineDigits = diff.hunks.reduce((max, hunk) => hunk.lines.reduce((digits, line) => Math.max(digits, String(line.oldLine ?? '').length, String(line.newLine ?? '').length), max), 4);
  const isSelectable = (line: DiffLine) => !!hunkAction && !reason && !!fingerprint && (line.kind === 'add' || line.kind === 'remove');

  // ----- Row model and virtual window -----
  const rows = useMemo(() => diffRows(diff.hunks, split), [diff, split]);
  const virtual = rows.length > DIFF_VIRTUALIZE_ABOVE;
  const metrics = useRef<Metrics | null>(null);
  if (!metrics.current) { metrics.current = { rowsTop: 0, surfaceWidth: 0 } as Metrics; resetMetrics(metrics.current, rows, split); }
  else if (metrics.current.rows !== rows) resetMetrics(metrics.current, rows, split);
  const m = metrics.current;
  const initialEnd = Math.min(rows.length, Math.ceil((FALLBACK_VIEWPORT / DIFF_ROW_ESTIMATE.unified + DIFF_OVERSCAN) / RANGE_STEP) * RANGE_STEP);
  const [rangeState, setRangeState] = useState({ rows, start: 0, end: initialEnd });
  const range = !virtual ? { start: 0, end: rows.length } : rangeState.rows === rows ? rangeState : { start: 0, end: initialEnd };
  const [, setLayoutVersion] = useState(0);

  const baseId = useId();
  const rowId = (index: number) => `${baseId}-row-${index}`;
  const [activeState, setActiveState] = useState<{ rows: DiffRow[]; row: number; side: Side } | null>(null);
  const active = activeState?.rows === rows ? activeState : null;
  const reveal = useRef(0);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const horizontalScroll = useRef<HTMLDivElement>(null);
  const live = useRef({ rows, virtual, split });
  live.current = { rows, virtual, split };

  /** Recompute the rendered window from the scroller position. */
  const syncRange = () => {
    const surface = surfaceRef.current;
    const current = live.current;
    if (!surface || !current.virtual) return;
    const next = visibleRows(m.offsets, surface.scrollTop - m.rowsTop, surface.clientHeight || FALLBACK_VIEWPORT, DIFF_OVERSCAN, RANGE_STEP);
    setRangeState(state => state.rows === current.rows && state.start === next.start && state.end === next.end ? state : { rows: current.rows, ...next });
  };

  /** Re-derive offsets while keeping the first visible row at the same screen position. */
  const anchored = (change: () => void) => {
    const surface = surfaceRef.current;
    if (!surface || !live.current.virtual) { change(); return; }
    const before = surface.scrollTop - m.rowsTop;
    const anchor = rowAt(m.offsets, before);
    const delta = before - m.offsets[anchor];
    change();
    if (before <= 0 || anchor >= m.rows.length) return;
    const target = m.rowsTop + m.offsets[anchor] + Math.min(delta, m.offsets[anchor + 1] - m.offsets[anchor]);
    if (Math.abs(target - surface.scrollTop) > 0.5) surface.scrollTop = target;
  };

  // Horizontal overflow, preferences, and scroll wiring. Only rendered rows are measured; the widest overflow
  // seen is kept so the scroll width does not jump as rows leave the window.
  const widthFrame = useRef(0);
  const measureWidth = () => {
    widthFrame.current = 0;
    const surface = surfaceRef.current, content = contentRef.current;
    if (!surface || !content) return;
    const wrap = wrapped();
    if (live.current.split) {
      const scrollbar = horizontalScroll.current;
      if (!scrollbar) return;
      let codeWidth = 0;
      if (wrap) m.widest = 0;
      else for (const code of content.querySelectorAll<HTMLElement>('.split-code')) {
        codeWidth = code.clientWidth;
        if (code.scrollWidth > code.clientWidth) m.widest = Math.max(m.widest, code.scrollWidth);
      }
      const overflow = wrap || !codeWidth ? 0 : Math.max(0, m.widest - codeWidth);
      const track = scrollbar.firstElementChild as HTMLElement;
      track.style.width = `${surface.clientWidth + overflow}px`;
      scrollbar.style.display = overflow > 0 ? 'block' : 'none';
      if (wrap) scrollbar.scrollLeft = 0;
      surface.style.setProperty('--split-scroll-offset', `${scrollbar.scrollLeft}px`);
    } else if (live.current.virtual && !wrap) {
      const available = content.clientWidth;
      for (const element of content.children) {
        const width = (element as HTMLElement).offsetWidth;
        if ((element as HTMLElement).dataset.row !== undefined && width > available + 0.5) m.widest = Math.max(m.widest, width);
      }
      content.style.minWidth = m.widest ? `${m.widest}px` : '';
    } else {
      m.widest = 0;
      content.style.minWidth = '';
    }
  };
  const scheduleWidth = () => {
    if (widthFrame.current) return;
    if (typeof requestAnimationFrame === 'undefined') { measureWidth(); return; }
    widthFrame.current = requestAnimationFrame(measureWidth);
  };

  /** Drop measured heights (wrapping, font, or wrapped width changed) without moving the visible row. */
  const invalidate = () => {
    anchored(() => {
      m.heights.fill(0); m.sums = [0, 0]; m.counts = [0, 0]; m.widest = 0;
      contentRef.current?.style.removeProperty('min-width');
      relayout(m);
    });
    syncRange();
    setLayoutVersion(version => version + 1);
    scheduleWidth();
  };

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    m.surfaceWidth = surface.clientWidth;
    const resize = () => {
      const width = surface.clientWidth;
      const widthChanged = width !== m.surfaceWidth;
      m.surfaceWidth = width;
      if (widthChanged && wrapped() && live.current.virtual) invalidate();
      else { syncRange(); scheduleWidth(); }
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(surface);
    const preferences = typeof MutationObserver !== 'undefined' ? new MutationObserver(invalidate) : null;
    preferences?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-diff-wrap', 'style'] });
    const scroll = () => syncRange();
    surface.addEventListener('scroll', scroll, { passive: true });
    const wheel = (event: WheelEvent) => {
      const scrollbar = horizontalScroll.current;
      if (!live.current.split || !scrollbar) return;
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta || scrollbar.style.display === 'none') return;
      const previous = scrollbar.scrollLeft;
      scrollbar.scrollLeft += delta * (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? surface.clientWidth : 1);
      if (scrollbar.scrollLeft !== previous) {
        event.preventDefault();
        surface.style.setProperty('--split-scroll-offset', `${scrollbar.scrollLeft}px`);
      }
    };
    surface.addEventListener('wheel', wheel, { passive: false });
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) invalidate(); });
    return () => {
      alive = false;
      observer?.disconnect(); preferences?.disconnect();
      surface.removeEventListener('scroll', scroll); surface.removeEventListener('wheel', wheel);
      if (widthFrame.current && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(widthFrame.current);
      widthFrame.current = 0;
    };
  }, []);

  // A new diff or layout starts with fresh width bookkeeping and a window derived from the current scroll position.
  useLayoutEffect(() => {
    contentRef.current?.style.removeProperty('min-width');
    syncRange();
    measureWidth();
  }, [rows]);

  // After every render: measure rendered row heights, keep the first visible row anchored, reveal the active row.
  useLayoutEffect(() => {
    const surface = surfaceRef.current, content = contentRef.current;
    if (!surface || !content) return;
    if (virtual) {
      const spacer = content.querySelector<HTMLElement>(':scope > .diff-virtual-spacer');
      // The virtualized surface is positioned, so the spacer's offsetTop is its position in scroll content.
      const top = spacer?.offsetParent === surface ? spacer.offsetTop : m.rowsTop;
      const moved = Math.abs(top - m.rowsTop) > 0.5;
      m.rowsTop = top;
      const updates: [number, number][] = [];
      for (const element of content.children) {
        const index = (element as HTMLElement).dataset.row;
        if (index === undefined) continue;
        const height = rowBox(element)?.getBoundingClientRect().height ?? 0;
        if (height > 0 && Math.abs(height - m.heights[+index]) > 0.5) updates.push([+index, height]);
      }
      if (updates.length) {
        anchored(() => {
          for (const [index, height] of updates) {
            const c = rowClass(m.rows[index]);
            if (m.heights[index]) { m.sums[c] -= m.heights[index]; m.counts[c]--; }
            m.heights[index] = height; m.sums[c] += height; m.counts[c]++;
          }
          relayout(m);
          // Apply the new spacer sizes before restoring the scroll position so the browser does not clamp it.
          const spacers = content.querySelectorAll<HTMLElement>(':scope > .diff-virtual-spacer');
          if (spacers.length === 2) {
            spacers[0].style.height = `${m.offsets[range.start]}px`;
            spacers[1].style.height = `${m.offsets[m.rows.length] - m.offsets[range.end]}px`;
          }
        });
        setLayoutVersion(version => version + 1);
      }
      if (updates.length || moved) syncRange();
    }
    if (reveal.current > 0 && active) {
      const element = content.querySelector<HTMLElement>(`:scope > [data-row="${active.row}"]`);
      const box = element && (element.classList.contains('split-row') ? element.querySelector<HTMLElement>(`.split-cell[data-side="${active.side}"]`) ?? rowBox(element) : element);
      if (box) {
        reveal.current = 0;
        const header = split ? content.querySelector<HTMLElement>('.split-column-header')?.offsetHeight ?? 0 : 0;
        const rect = box.getBoundingClientRect(), frame = surface.getBoundingClientRect();
        const top = frame.top + surface.clientTop + header, bottom = frame.top + surface.clientTop + surface.clientHeight;
        if (rect.top < top) surface.scrollTop -= top - rect.top;
        else if (rect.bottom > bottom && surface.clientHeight) surface.scrollTop += Math.min(rect.bottom - bottom, rect.top - top);
        syncRange();
      } else if (virtual) {
        // Not rendered yet: jump to its estimated offset and let the next render reveal it precisely.
        reveal.current--;
        surface.scrollTop = Math.max(0, m.rowsTop + m.offsets[active.row] - (surface.clientHeight || FALLBACK_VIEWPORT) / 2);
        syncRange();
      } else reveal.current = 0;
    }
    scheduleWidth();
  });

  // ----- Roving line focus -----
  /** The side that Space/Enter acts on: the preferred side if it is selectable, else a selectable counterpart. */
  const effectiveSide = (row: SplitDiffRow, preferred: Side): Side => {
    const other: Side = preferred === 'before' ? 'after' : 'before';
    const usable = (side: Side) => !!row[side] && isSelectable(row[side]!.line);
    if (usable(preferred)) return preferred;
    if (usable(other)) return other;
    return row[preferred] ? preferred : other;
  };
  const activeLine = (index: number, side: Side): SplitDiffLine | undefined => {
    const row = rows[index];
    if (!row || row.kind === 'hunk') return undefined;
    if (row.kind === 'line') return row.item;
    return row.row.meta ?? row.row[effectiveSide(row.row, side)];
  };
  const setActive = (row: number, side: Side, scroll: boolean) => {
    if (scroll) reveal.current = 3;
    setActiveState({ rows, row, side });
  };
  const firstVisibleRow = () => {
    const surface = surfaceRef.current;
    if (!surface) return 0;
    if (virtual) return rowAt(m.offsets, surface.scrollTop - m.rowsTop);
    const frame = surface.getBoundingClientRect();
    const element = [...(contentRef.current?.children ?? [])].find(child => (child as HTMLElement).dataset.row !== undefined && (rowBox(child)?.getBoundingClientRect().bottom ?? 0) > frame.top);
    return element ? Number((element as HTMLElement).dataset.row) : 0;
  };
  const step = (from: number, direction: 1 | -1) => {
    for (let index = from + direction; index >= 0 && index < rows.length; index += direction) if (rows[index].kind !== 'hunk') return index;
    return from;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const fromSurface = target === event.currentTarget;
    if (!fromSurface && !target.classList.contains('line-select-toggle')) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const side = active?.side ?? 'before';
    const inWindow = active && active.row >= range.start && active.row < range.end;
    const navigate = (row: number, nextSide = side) => {
      event.preventDefault();
      if (!rows[row] || rows[row].kind === 'hunk') return;
      if (!fromSurface) surfaceRef.current?.focus({ preventScroll: true });
      setActive(row, nextSide, true);
    };
    const firstLine = () => { const first = firstVisibleRow(); return rows[first]?.kind === 'hunk' ? step(first, 1) : first; };
    switch (event.key) {
      case 'ArrowDown': return navigate(active && inWindow ? step(active.row, 1) : firstLine());
      case 'ArrowUp': return navigate(active && inWindow ? step(active.row, -1) : firstLine());
      case 'Home': return navigate(step(-1, 1));
      case 'End': return navigate(step(rows.length, -1));
      case 'ArrowLeft': case 'ArrowRight': {
        if (!split || !active || rows[active.row]?.kind !== 'split') return;
        return navigate(active.row, event.key === 'ArrowLeft' ? 'before' : 'after');
      }
      case ' ': case 'Enter': {
        if (!fromSurface || !active) return;
        event.preventDefault();
        const row = rows[active.row];
        const item = activeLine(active.row, side);
        if (row && item && isSelectable(item.line)) toggleLine(row.hunkIndex, item.index);
      }
    }
  };

  let activeDescendant: string | undefined;
  if (active && active.row >= range.start && active.row < range.end && rows[active.row]) {
    const row = rows[active.row];
    if (row.kind === 'line') activeDescendant = isSelectable(row.item.line) ? `${rowId(active.row)}-toggle` : rowId(active.row);
    else if (row.kind === 'split' && row.row.meta) activeDescendant = rowId(active.row);
    else if (row.kind === 'split') {
      const side = effectiveSide(row.row, active.side);
      const item = row.row[side];
      activeDescendant = item && isSelectable(item.line) ? `${rowId(active.row)}-${side}-toggle` : `${rowId(active.row)}-${side}`;
    }
  }
  const activeSplitSide = active && rows[active.row]?.kind === 'split' ? effectiveSide((rows[active.row] as Extract<DiffRow, { kind: 'split' }>).row, active.side) : null;

  // ----- Rendering -----
  function splitCell(item: SplitDiffLine | undefined, side: Side, hunkIndex: number, index: number) {
    const activeCell = active?.row === index && activeSplitSide === side;
    if (!item) return <div id={`${rowId(index)}-${side}`} data-side={side} className={`split-cell split-cell-empty${activeCell ? ' diff-active' : ''}`} aria-hidden="true"><span className="split-gutter" /><span className="split-code" /></div>;
    const { line, index: lineIndex } = item;
    const selectable = isSelectable(line);
    const isSelected = selectable && (selected[hunkIndex] ?? []).includes(lineIndex);
    const number = side === 'before' ? line.oldLine : line.newLine;
    return <div id={`${rowId(index)}-${side}`} data-side={side} className={`split-cell ${line.kind}${isSelected ? ' selected-line' : ''}${activeCell ? ' diff-active' : ''}`}>
      <span className="split-gutter"><span className="split-line-action">{selectable && <button type="button" id={`${rowId(index)}-${side}-toggle`} tabIndex={-1} className="line-select-toggle" aria-pressed={isSelected} disabled={busy} title={`${isSelected ? 'Deselect' : 'Select'} line for ${actionVerb}`} aria-label={`${isSelected ? 'Deselect' : 'Select'} line ${number ?? ''} for ${actionVerb} (${side})`} onClick={() => { toggleLine(hunkIndex, lineIndex); setActive(index, side, false); }}>{isSelected && <Check size={10} strokeWidth={3} aria-hidden="true" />}</button>}</span><span className="split-line-number">{number ?? ''}</span><span className="split-line-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}</span></span>
      <pre className="split-code">{line.content}</pre>
    </div>;
  }

  function hunkHeader(hunkIndex: number, index: number) {
    const hunk = diff.hunks[hunkIndex];
    const hunkSelected = selected[hunkIndex] ?? [];
    const hasSelection = hunkSelected.length > 0;
    const buttonLabel = hasSelection
      ? hunkAction === 'unstage_hunk' ? 'Unstage selected lines' : 'Stage selected lines'
      : hunkAction === 'unstage_hunk' ? 'Unstage hunk' : 'Stage hunk';
    return <div key={index} data-row={index} data-hunk={hunkIndex} className="hunk-header hunk-action-header">
      <span>{hunk.header}</span>
      {hunkAction && (
        <button
          className="hunk-action-button"
          disabled={busy || !fingerprint || !onHunk}
          title={reason}
          aria-label={`${buttonLabel} ${hunkIndex + 1} in ${diff.path}`}
          onClick={() => {
            if (!busy && fingerprint && onHunk) {
              if (hasSelection) {
                onHunk({
                  kind: hunkAction,
                  path: diff.path,
                  hunkIndex,
                  fingerprint,
                  lineIndices: [...hunkSelected].sort((a, b) => a - b),
                });
              } else {
                onHunk({
                  kind: hunkAction,
                  path: diff.path,
                  hunkIndex,
                  fingerprint,
                });
              }
            }
          }}
        >
          {buttonLabel}
        </button>
      )}
    </div>;
  }

  function renderRow(row: DiffRow, index: number) {
    if (row.kind === 'hunk') return hunkHeader(row.hunkIndex, index);
    const activeRow = active?.row === index;
    if (row.kind === 'split') {
      if (row.row.meta) return <pre key={index} id={rowId(index)} data-row={index} className={`split-meta${activeRow ? ' diff-active' : ''}`}>{row.row.meta.line.content}</pre>;
      return <div key={index} data-row={index} className="split-row">{splitCell(row.row.before, 'before', row.hunkIndex, index)}{splitCell(row.row.after, 'after', row.hunkIndex, index)}</div>;
    }
    const { line, index: lineIndex } = row.item;
    const selectable = isSelectable(line);
    const isSelected = selectable && (selected[row.hunkIndex] ?? []).includes(lineIndex);
    const lineNum = line.kind === 'add' ? line.newLine : line.oldLine;
    return (
      <pre key={index} id={rowId(index)} data-row={index} className={`${line.kind}${isSelected ? ' selected-line' : ''}${activeRow ? ' diff-active' : ''}`}>
        {selectable && (
          <button
            type="button"
            id={`${rowId(index)}-toggle`}
            tabIndex={-1}
            className="line-select-toggle"
            aria-pressed={isSelected}
            disabled={busy}
            title={`${isSelected ? 'Deselect' : 'Select'} line for ${actionVerb}`}
            aria-label={`${isSelected ? 'Deselect' : 'Select'} line ${lineNum ?? ''} for ${actionVerb}`}
            onClick={() => { toggleLine(row.hunkIndex, lineIndex); setActive(index, 'before', false); }}
          >
            {isSelected && <Check size={10} strokeWidth={3} aria-hidden="true" />}
          </button>
        )}
        <span className="line-number">{line.oldLine ?? ''}</span>
        <span className="line-number">{line.newLine ?? ''}</span>
        {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
        {line.content}
      </pre>
    );
  }

  const rendered = rows.slice(range.start, range.end).map((row, offset) => renderRow(row, range.start + offset));
  const total = m.offsets[rows.length];
  const contentStyle = { ...(split ? { '--split-line-number-width': `${lineDigits}ch` } : {}) } as CSSProperties;

  return <><div className="diff-messages" role="status">{diff.binary && <p>Binary file · textual preview unavailable.</p>}{diff.truncated && <p>Diff truncated · only the available preview is shown.</p>}{diff.message && <p>{diff.message}</p>}{reason && <p className="hunk-unavailable">{reason}</p>}{!diff.hunks.length && !diff.binary && <p>No textual hunks · metadata-only or empty file change.</p>}</div><div ref={surfaceRef} className={`native-diff ${split ? 'split' : ''}`} role="group" tabIndex={0} aria-label={`${split ? 'Side-by-side' : 'Unified'} diff for ${diff.path}`} aria-activedescendant={activeDescendant} aria-keyshortcuts="ArrowUp ArrowDown Home End Space" data-virtual={virtual || undefined} onKeyDown={onKeyDown}>
    <div ref={contentRef} className={split ? 'split-content' : 'unified-content'} style={split ? contentStyle : undefined} data-virtual-height={virtual ? total : undefined}>
    {split && !!diff.hunks.length && <div className="split-column-header"><span><span className="split-side-dot before" />Before<small>Original</small></span><span><span className="split-side-dot after" />After<small>Modified</small></span></div>}
    {virtual && <div className="diff-virtual-spacer" aria-hidden="true" style={{ height: m.offsets[range.start] }} />}
    {rendered}
    {virtual && <div className="diff-virtual-spacer" aria-hidden="true" style={{ height: total - m.offsets[range.end] }} />}
    </div>
  </div>{split && <div ref={horizontalScroll} className="split-horizontal-scroll" tabIndex={0} role="region" aria-label="Scroll both diff sides horizontally" onScroll={event => surfaceRef.current?.style.setProperty('--split-scroll-offset', `${event.currentTarget.scrollLeft}px`)}><div /></div>}</>;
}
