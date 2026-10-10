import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StatusEntry } from '../model/repository';
import { rowOffsets, visibleRows } from '../model/splitDiff';

export const WORKING_FILES_VIRTUALIZE_ABOVE = 200;
export const WORKING_FILE_ESTIMATE = 34;
const OVERSCAN = 12;
interface FileMetrics { heights: Map<number, number>; offsets: Float64Array; width: number }

/** Each group shares the sidebar's scroller. Rows keep their natural (possibly wrapped)
 * heights; offscreen space is estimated until measured. A focused row stays mounted
 * even when mouse scrolling moves it outside the window. */
export function WorkingFileWindow({ entries, collapsed, layoutKey, children }: {
  entries: StatusEntry[]; collapsed: boolean; layoutKey: unknown;
  children: (entry: StatusEntry, tabIndex?: number) => ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const virtual = entries.length > WORKING_FILES_VIRTUALIZE_ABOVE;
  const previousMetrics = useRef<{ entries: StatusEntry[]; metrics: FileMetrics } | null>(null);
  const metrics = useMemo(() => {
    const previous = previousMetrics.current;
    // Polling publishes new entry objects even when the file order is unchanged.
    // Retain their measured offsets so a refresh cannot jump a deep viewport back
    // to estimates. ResizeObserver remeasures changed labels in mounted rows.
    const unchanged = previous?.entries.length === entries.length && entries.every((entry, index) => entry.path === previous.entries[index].path);
    const metrics = unchanged ? previous.metrics : { heights: new Map<number, number>(), offsets: rowOffsets(entries.length, () => WORKING_FILE_ESTIMATE), width: 0 };
    previousMetrics.current = { entries, metrics };
    return metrics;
  }, [entries]);
  const [window, setWindow] = useState({ metrics, start: 0, end: Math.min(entries.length, 36) });
  const [focus, setFocus] = useState<{ path: string; index: number } | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const focused = focus && entries[focus.index]?.path === focus.path ? focus.index : null;
  const range = window.metrics === metrics ? window : { start: 0, end: Math.min(entries.length, 36) };
  const update = useRef<() => void>(() => {});
  const [, relayout] = useState(0);

  useLayoutEffect(() => {
    if (!virtual || collapsed) return;
    const node = host.current!;
    const scroller = node.closest<HTMLElement>('.working-files-list')!;
    const groupTop = () => node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop;
    const measure = () => {
      let changed = false;
      const width = node.getBoundingClientRect().width;
      if (metrics.width && width && metrics.width !== width) { metrics.heights.clear(); changed = true; }
      if (width) metrics.width = width;
      for (const row of node.querySelectorAll<HTMLElement>('[data-working-index]')) {
        const index = Number(row.dataset.workingIndex);
        const height = row.getBoundingClientRect().height;
        if (height > 0 && metrics.heights.get(index) !== height) { metrics.heights.set(index, height); changed = true; }
      }
      if (!changed) return;
      const top = groupTop();
      const anchor = visibleRows(metrics.offsets, scroller.scrollTop - top, 0, 0, 1).start;
      const oldOffset = metrics.offsets[anchor];
      const average = metrics.heights.size ? [...metrics.heights.values()].reduce((sum, height) => sum + height, 0) / metrics.heights.size : WORKING_FILE_ESTIMATE;
      metrics.offsets = rowOffsets(entries.length, i => metrics.heights.get(i) ?? average);
      // Keep the first visible file stationary as estimates become measured heights.
      if (scroller.scrollTop > top && scroller.scrollTop < top + metrics.offsets[entries.length]) scroller.scrollTop += metrics.offsets[anchor] - oldOffset;
      relayout(value => value + 1);
    };
    const sync = () => {
      const top = scroller.scrollTop - groupTop();
      const height = scroller.clientHeight || 600;
      const next = top + height < 0 || top > metrics.offsets[entries.length]
        ? { start: 0, end: 0 }
        : visibleRows(metrics.offsets, top, height, OVERSCAN, 4);
      setWindow(current => current.metrics === metrics && current.start === next.start && current.end === next.end ? current : { metrics, ...next });
    };
    update.current = sync;
    measure(); sync();
    scroller.addEventListener('scroll', sync, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { measure(); sync(); });
    observer?.observe(node);
    observer?.observe(scroller);
    for (const row of node.querySelectorAll<HTMLElement>('[data-working-index]')) observer?.observe(row);
    return () => { scroller.removeEventListener('scroll', sync); observer?.disconnect(); };
  }, [virtual, collapsed, layoutKey, entries, metrics, range.start, range.end, focused]);

  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const button = host.current?.querySelector<HTMLButtonElement>(`[data-working-index="${index}"] .working-file-select`);
    if (button) { pendingFocus.current = null; button.focus({ preventScroll: true }); }
  });

  const indices = !virtual ? entries.map((_, i) => i) : collapsed ? [] : Array.from({ length: range.end - range.start }, (_, i) => range.start + i);
  if (virtual && !collapsed && focused !== null && !indices.includes(focused)) { indices.push(focused); indices.sort((a, b) => a - b); }
  let previous = 0;
  return <div ref={host} className="working-file-window" data-virtual={virtual || undefined}
    onFocusCapture={event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-working-index]');
      if (row) { const index = Number(row.dataset.workingIndex); setFocus({ path: entries[index].path, index }); }
    }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocus(null); }}
    onKeyDown={event => {
      if (!virtual || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-working-index]');
      if (!row || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = Number(row.dataset.workingIndex);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      const scroller = host.current!.closest<HTMLElement>('.working-files-list')!;
      const top = host.current!.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop;
      const height = scroller.clientHeight || 600;
      // Leave room for the sticky group heading.
      if (top + metrics.offsets[next] < scroller.scrollTop + 32) scroller.scrollTop = Math.max(0, top + metrics.offsets[next] - 32);
      else if (top + metrics.offsets[next + 1] > scroller.scrollTop + height) scroller.scrollTop = top + metrics.offsets[next + 1] - height;
      pendingFocus.current = next;
      setFocus({ path: entries[next].path, index: next });
      update.current();
    }}>
    {indices.map(index => {
      const gap = virtual ? metrics.offsets[index] - metrics.offsets[previous] : 0;
      previous = index + 1;
      return <Fragment key={entries[index].path}>
        {gap > 0 && <div className="working-file-spacer" aria-hidden="true" style={{ height: gap }} />}
        <div data-working-index={index}>{children(entries[index], virtual ? index === (focused ?? range.start) ? 0 : -1 : undefined)}</div>
      </Fragment>;
    })}
    {virtual && !collapsed && previous < entries.length && <div className="working-file-spacer" aria-hidden="true" style={{ height: metrics.offsets[entries.length] - metrics.offsets[previous] }} />}
  </div>;
}
