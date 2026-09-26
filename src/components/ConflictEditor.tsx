import { useEffect, useRef, useState } from 'react';
import type { ConflictFile, ConflictResolution } from '../model/operations';
import { native, errorMessage } from '../model/native';
import { acceptBlock, conflictBlocks, editConflictText } from '../model/operationUi';
import type { OperationWrite } from './OperationDialog';

export function ConflictEditor({ handle, path, revision, busy, onWrite, onClose }: { handle: string; path: string; revision: number; busy: boolean; onWrite: OperationWrite; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<ConflictFile | null>(null);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [external, setExternal] = useState<ConflictFile | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [reading, setReading] = useState(true);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [blockIndex, setBlockIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const buffer = useRef({ file, dirty }); buffer.current = { file, dirty };
  const alive = useRef(true);
  const result = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { alive.current = true; dialog.current?.showModal(); const check = () => setRetry(value => value + 1); const timer = setInterval(() => { if (!document.hidden) check(); }, 5000); window.addEventListener('focus', check); return () => { alive.current = false; clearInterval(timer); window.removeEventListener('focus', check); }; }, []);
  function install(value: ConflictFile) { buffer.current = { file: value, dirty: false }; setFile(value); setText(value.result ?? ''); setDirty(false); setExternal(null); setBlockIndex(0); }
  function edit(value: string) { buffer.current.dirty = true; setText(value); setDirty(true); }
  useEffect(() => {
    let live = true;
    setReading(true);
    native<ConflictFile>('repository_conflict_file', { handle, path }).then(value => {
      if (!live) return;
      setReadError('');
      if (buffer.current.file?.fingerprint === value.fingerprint) return;
      if (buffer.current.dirty) setExternal(value); else install(value);
    }).catch(e => { if (live) setReadError(errorMessage(e)); }).finally(() => { if (live) setReading(false); });
    return () => { live = false; };
  }, [handle, path, revision, retry]);
  const blocks = conflictBlocks(text);
  const index = Math.min(blockIndex, Math.max(0, blocks.length - 1));
  function navigate(next: number) {
    const i = Math.max(0, Math.min(blocks.length - 1, next)); setBlockIndex(i);
    const block = blocks[i]; if (block && result.current) { result.current.focus(); result.current.setSelectionRange(text.slice(0, block.start).replace(/\r\n?/g, '\n').length, text.slice(0, block.end).replace(/\r\n?/g, '\n').length); }
  }
  async function save(resolution: ConflictResolution) {
    if (!file || blocked || saving.current) return;
    saving.current = true;
    setPending(true); setError('');
    try {
      await onWrite('repository_resolve_conflict', { path, fingerprint: file.fingerprint, resolution });
      if (alive.current) { setDirty(false); onClose(); }
    } catch (e) { if (alive.current) { setError(errorMessage(e)); setRetry(value => value + 1); } }
    finally { saving.current = false; if (alive.current) setPending(false); }
  }
  const blocked = busy || pending || reading || !!readError || !!external || !file;
  const unsupportedMode = file?.reason?.startsWith('Submodule, directory/file or special-file') ?? false;
  const gitlink = file?.ours?.mode === '160000' && file?.theirs?.mode === '160000' && file?.reason?.startsWith('Submodule pointer conflict');
  return <dialog ref={dialog} className="dialog operation-dialog" aria-label={`Resolve ${path}`} onCancel={e => { if (pending || dirty) e.preventDefault(); else onClose(); }}>
    <h2>Resolve conflict</h2><p><code>{path}</code></p>
    {error && <p role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>Reload status</button></p>}
    {readError && <p role="alert">Conflict status could not be confirmed: {readError} <button onClick={() => setRetry(value => value + 1)}>Retry conflict read</button></p>}
    {external && <div role="alert"><p>This file changed outside this editor. Your edits are preserved. Copy them before loading the new versions; stale saves are blocked.</p><button onClick={() => install(external)}>Discard editor edits and load external version</button></div>}
    {!file ? <p>Reading full conflict content…</p> : <>
      <div className="conflict-versions">{([['Base', file.base], [file.oursLabel, file.ours], [file.theirsLabel, file.theirs]] as const).map(([label, version], index) => <section key={index}><h3>{label}</h3><pre>{version === null ? '(Absent / deleted)' : version.mode === '160000' ? `Submodule commit ${version.oid}` : version.content === null ? '(Binary or content exceeds editor bounds)' : version.content}</pre></section>)}</div>
      {file.reason && <p>{file.reason}</p>}
      {file.editable ? <><div className="operation-buttons"><span>{blocks.length ? `Block ${index + 1} of ${blocks.length}` : 'No conflict marker blocks'}</span><button disabled={!blocks.length || !index} onClick={() => navigate(index - 1)}>Previous block</button><button disabled={!blocks.length || index === blocks.length - 1} onClick={() => navigate(index + 1)}>Next block</button>{(['current', 'incoming', 'both'] as const).map(choice => <button key={choice} disabled={!blocks.length || blocked} onClick={() => edit(acceptBlock(text, blocks[index], choice))}>Accept {choice}</button>)}</div>
        <label>Editable result<textarea ref={result} className="conflict-result" spellCheck={false} value={text.replace(/\r\n?/g, '\n')} disabled={pending} onChange={event => edit(editConflictText(text, event.target.value))} /></label>
        <p>{text.includes('\r\n') ? 'CRLF' : 'LF'} · {text.endsWith('\n') ? 'Final newline present' : 'No final newline'} · {dirty ? 'Unsaved editor changes' : 'Loaded working content'}</p><button className="primary-button" disabled={blocked || !!blocks.length} onClick={() => void save({ kind: 'text', content: text })}>Save result &amp; mark resolved</button>
      </> : <p>Text editing is unavailable for this content. Choose a complete version, keep the working file, or delete the path.</p>}
      <div className="operation-buttons"><button disabled={blocked || unsupportedMode} onClick={() => void save({ kind: file.ours ? 'ours' : 'delete' })}>{file.ours ? `Use ${file.oursLabel}` : `Accept deletion (${file.oursLabel})`}</button><button disabled={blocked || unsupportedMode} onClick={() => void save({ kind: file.theirs ? 'theirs' : 'delete' })}>{file.theirs ? `Use ${file.theirsLabel}` : `Accept deletion (${file.theirsLabel})`}</button><button disabled={blocked || unsupportedMode || gitlink} onClick={() => void save({ kind: 'delete' })}>Delete path &amp; resolve</button><button disabled={blocked || unsupportedMode || gitlink || dirty || !!blocks.length || [file.base, file.ours, file.theirs].some(version => version?.mode === '120000')} onClick={() => void save({ kind: 'working' })}>Mark working file resolved</button></div>
    </>}
    <button className="text-button" disabled={pending} onClick={onClose}>{dirty ? 'Discard editor edits & close' : 'Close'}</button>
  </dialog>;
}
