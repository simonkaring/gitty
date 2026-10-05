import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';
import { errorMessage } from '../model/native';

export function WindowControls({ onError }: { onError: (message: string) => void }) {
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
    <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => run('minimize')}><Minus size={16} /></button>
    <button type="button" aria-label={maximized ? 'Restore window' : 'Maximize window'} title={maximized ? 'Restore' : 'Maximize'} onClick={() => run('toggleMaximize')}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
    <button type="button" className="window-close" aria-label="Close window" title="Close" onClick={() => run('close')}><X size={17} /></button>
  </div>;
}
