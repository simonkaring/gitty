import { useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { NativeWorkspace } from './components/NativeWorkspace';
import { setDemoMode } from './model/native';
import { AskPassDialog } from './components/AskPassDialog';
import { EditorDialog } from './components/EditorDialog';

export default function App() {
  const [demo, setDemo] = useState(() => !isTauri());
  setDemoMode(demo);
  return <>
    <NativeWorkspace key={String(demo)} demo={demo} onToggleDemo={isTauri() ? () => setDemo(!demo) : undefined} />
    {isTauri() && <AskPassDialog />}
    {isTauri() && <EditorDialog />}
  </>;
}
