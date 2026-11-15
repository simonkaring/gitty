import { useEffect, useState } from 'react';
import { NativeWorkspace } from './components/NativeWorkspace';
import { initializeTestHost, isDesktopHost, isRealBackendTest, setDemoMode, subscribeNative } from './model/native';
import { recordGitCommand, type GitCommandEvent } from './model/activity';
import { AskPassDialog } from './components/AskPassDialog';
import { EditorDialog } from './components/EditorDialog';

export default function App() {
  const desktop = isDesktopHost();
  const testHost = isRealBackendTest();
  const [demo, setDemo] = useState(() => !desktop && !testHost);
  const [fixture, setFixture] = useState<import('./model/repository').RepositoryLocation>();
  const [cloneParent, setCloneParent] = useState<string>();
  const [fixtureError, setFixtureError] = useState('');
  setDemoMode(demo);
  useEffect(() => {
    if (testHost) {
      void initializeTestHost().then(session => { setFixture(session.location); setCloneParent(session.cloneParent); }).catch(error => setFixtureError(String(error)));
    }
    if (!desktop && !testHost) return;
    const unlisten = subscribeNative<GitCommandEvent>('git_command', recordGitCommand).catch(() => () => {});
    return () => { void unlisten.then(fn => fn()); };
  }, [desktop, testHost]);
  if (testHost && fixtureError) return <main role="alert">Test host failed: {fixtureError}</main>;
  if (testHost && !fixture) return <main role="status">Starting isolated real-Git fixture…</main>;
  return <>
    <NativeWorkspace key={String(demo)} demo={demo} initialLocation={fixture} cloneParent={cloneParent} onToggleDemo={desktop ? () => setDemo(!demo) : undefined} />
    {desktop && <AskPassDialog />}
    {desktop && <EditorDialog />}
  </>;
}
