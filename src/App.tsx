import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { NativeWorkspace } from './components/NativeWorkspace';
import { setDemoMode } from './model/native';
import { recordGitCommand, type GitCommandEvent } from './model/activity';
import { AskPassDialog } from './components/AskPassDialog';
import { EditorDialog } from './components/EditorDialog';

export default function App() {
  const [demo, setDemo] = useState(() => !isTauri());
  setDemoMode(demo);
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<GitCommandEvent>('git_command', event => recordGitCommand(event.payload));
    return () => { void unlisten.then(fn => fn()); };
  }, []);
  return <>
    <NativeWorkspace key={String(demo)} demo={demo} onToggleDemo={isTauri() ? () => setDemo(!demo) : undefined} />
    {isTauri() && <AskPassDialog />}
    {isTauri() && <EditorDialog />}
  </>;
}
