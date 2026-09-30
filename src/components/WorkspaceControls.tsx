import { GitBranch, GitCommitHorizontal, Files } from 'lucide-react';
import { useRef, type Dispatch, type SetStateAction } from 'react';
import { useSettings } from '../model/settings';

export function usePaneWidth(name: 'sidebar' | 'inspector', fallback: number, min: number, max: number) {
  const { settings, updateSettings } = useSettings();
  const clamp = (value: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const width = clamp(settings.paneWidths[name]);
  const setWidth: Dispatch<SetStateAction<number>> = value => updateSettings(current => ({
    paneWidths: { ...current.paneWidths, [name]: clamp(typeof value === 'function' ? value(clamp(current.paneWidths[name])) : value) },
  }));
  return [width, setWidth] as const;
}

export function Brand({ demo = false }: { demo?: boolean }) {
  return <div className="brand" data-tauri-drag-region><span className="brand-icon" data-tauri-drag-region><GitBranch size={22} /></span><span data-tauri-drag-region>gitty<span className="brand-period">.</span></span><span className="preview-label">{demo ? 'DEMO' : 'LOCAL GIT'}</span></div>;
}
export function ViewNavigation({ view, count, onChange }: { view: 'history' | 'working'; count: number; onChange: (view: 'history' | 'working') => void }) {
  return <nav className="view-navigation" aria-label="Workspace views"><button aria-current={view === 'history' ? 'page' : undefined} onClick={() => onChange('history')}><GitCommitHorizontal size={18} />History</button><button aria-current={view === 'working' ? 'page' : undefined} onClick={() => onChange('working')}><Files size={18} />Working changes<span className="count">{count}</span></button></nav>;
}
export function PaneResizer({ label, width, onChange, min = 300, max = 640, direction = -1 }: { label: string; width: number; onChange: (width: number) => void; min?: number; max?: number; direction?: 1 | -1 }) {
  const drag = useRef({ x: 0, width });
  const change = (value: number) => onChange(Math.max(min, Math.min(max, value)));
  return <div className="pane-resizer" role="separator" aria-label={label} aria-orientation="vertical" aria-valuenow={Math.round(width)} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
    onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); change(event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowRight' ? 20 : -20) * direction); } }}
    onPointerDown={event => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.dragging = 'true'; }}
    onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) change(drag.current.width + (event.clientX - drag.current.x) * direction); }}
    onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} onLostPointerCapture={event => { delete event.currentTarget.dataset.dragging; }} />;
}
