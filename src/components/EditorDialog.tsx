import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { EditorPromptPayload } from '../model/operations';

export function EditorDialog() {
  const [prompts, setPrompts] = useState<EditorPromptPayload[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

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

  useEffect(() => {
    if (prompts.length > 0 && !dialogRef.current?.open) {
      dialogRef.current?.showModal();
    }
  }, [prompts.length]);

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

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void answer(content);
  };

  const onCancel = () => {
    void answer(null);
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog editor-dialog"
      aria-label="Edit Git Message"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div className="dialog-heading">
        <span className="dialog-icon">✏️</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Cancel"
          disabled={submitting}
          onClick={onCancel}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <form onSubmit={onSubmit}>
        <h2>Edit Message</h2>
        <p style={{ wordBreak: 'break-all' }}>
          Editing <code>{current.fileName}</code>
        </p>
        <div style={{ margin: '20px 0' }}>
          <label htmlFor="editor-content" style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 550 }}>
            Commit Message
          </label>
          <textarea
            key={current.requestId}
            id="editor-content"
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={submitting}
            autoFocus
            rows={10}
            style={{
              width: '100%',
              minHeight: '180px',
              fontFamily: 'var(--mono)',
              fontSize: '13px',
              lineHeight: 1.5,
              padding: '10px 12px',
              borderRadius: '4px',
              border: '1px solid var(--border)',
              background: 'var(--bg-inset)',
              color: 'var(--text)',
              resize: 'vertical',
            }}
          />
        </div>
        {error && <p role="alert" style={{ color: 'var(--red, #e06c75)', marginBottom: '12px' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '24px' }}>
          <button type="button" className="secondary-button" disabled={submitting} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={submitting}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
