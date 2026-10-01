import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { EditorPromptPayload } from '../model/operations';
import { Dialog } from './ui';

export function EditorDialog() {
  const [prompts, setPrompts] = useState<EditorPromptPayload[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const unlistenPrompt = listen<EditorPromptPayload>('editor_prompt', (event) => {
      setPrompts((prev) => [...prev, event.payload]);
    });
    const unlistenExpired = listen<number>('editor_expired', (event) => {
      setPrompts((prev) => prev.filter((p) => p.requestId !== event.payload));
    });
    return () => {
      void unlistenPrompt.then((fn) => fn());
      void unlistenExpired.then((fn) => fn());
    };
  }, []);

  const current = prompts[0];
  const [content, setContent] = useState('');

  useEffect(() => {
    if (current) {
      setContent(current.content);
      setError('');
      textareaRef.current?.focus();
    }
  }, [current?.requestId, current?.content]);

  if (!current) return null;

  async function answer(newContent: string | null) {
    if (submitting) return;
    setSubmitting(true);
    try {
      await invoke('editor_reply', { requestId: current.requestId, content: newContent });
      setPrompts((prev) => prev.filter((prompt) => prompt.requestId !== current.requestId));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const onSubmit = () => {
    void answer(content);
  };

  const onCancel = () => {
    void answer(null);
  };

  return <Dialog title="Edit message" onClose={onCancel} onSubmit={onSubmit} footer={<>
    <button type="button" className="secondary-button" disabled={submitting} onClick={onCancel}>Cancel</button>
    <button type="submit" className="primary-button" disabled={submitting}>Save</button>
  </>}>
    <p className="muted">Git is waiting for <code>{current.fileName}</code>.</p>
    <label className="field">Message
      <textarea key={current.requestId} ref={textareaRef} className="mono" value={content} onChange={e => setContent(e.target.value)} disabled={submitting} autoFocus rows={10} />
    </label>
    {error && <p className="alert" role="alert">{error}</p>}
  </Dialog>;
}
