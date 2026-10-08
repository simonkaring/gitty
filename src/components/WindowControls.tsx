import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';
import { errorMessage } from '../model/native';

type WindowButton = 'minimize' | 'maximize' | 'close';
export const DEFAULT_BUTTON_LAYOUT = ':minimize,maximize,close';
const RESIZE_DIRECTIONS = ['North', 'South', 'East', 'West', 'NorthEast', 'NorthWest', 'SouthEast', 'SouthWest'] as const;

export function WindowResizeHandles({ onError }: { onError: (message: string) => void }) {
  return <div aria-hidden="true">{RESIZE_DIRECTIONS.map(direction => <div key={direction} className={`window-resize window-resize-${direction}`} data-tauri-drag-region="false" onMouseDown={event => {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startResizeDragging(direction).catch(error => onError(`Could not resize window: ${errorMessage(error)}`));
  }} />)}</div>;
}

export function parseWindowButtonLayout(layout: string): [WindowButton[], WindowButton[]] {
  const seen = new Set<string>();
  return (typeof layout === 'string' && layout.includes(':') ? layout : DEFAULT_BUTTON_LAYOUT).split(':', 2).map(side =>
    side.split(',').flatMap(button => {
      if (!['minimize', 'maximize', 'close'].includes(button) || seen.has(button)) return [];
      seen.add(button);
      return [button as WindowButton];
    })) as [WindowButton[], WindowButton[]];
}

export function WindowControls({ onError, buttons = ['minimize', 'maximize', 'close'] }: { onError: (message: string) => void; buttons?: WindowButton[] }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const window = getCurrentWindow();
    let disposed = false;
    const refresh = () => { void window.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(error => { if (!disposed) onError(errorMessage(error)); }); };
    const unlisten = window.onResized(refresh).catch(error => { if (!disposed) onError(errorMessage(error)); return () => {}; });
    refresh();
    return () => { disposed = true; void unlisten.then(stop => stop()); };
  }, [onError]);
  const run = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    void getCurrentWindow()[action]().catch(error => onError(`Could not update window: ${errorMessage(error)}`));
  };
  return <div className="window-controls" role="group" aria-label="Window controls">
    {buttons.map(button => button === 'minimize'
      ? <button key={button} type="button" aria-label="Minimize window" title="Minimize" onClick={() => run('minimize')}><Minus size={16} /></button>
      : button === 'maximize'
        ? <button key={button} type="button" aria-label={maximized ? 'Restore window' : 'Maximize window'} title={maximized ? 'Restore' : 'Maximize'} onClick={() => run('toggleMaximize')}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
        : <button key={button} type="button" className="window-close" aria-label="Close window" title="Close" onClick={() => run('close')}><X size={17} /></button>)}
  </div>;
}
