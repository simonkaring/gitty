import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

interface AskPassPrompt {
  requestId: number;
  prompt: string;
}

export function AskPassDialog() {
  const [prompts, setPrompts] = useState<AskPassPrompt[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unlistenPrompt = listen<AskPassPrompt>('git_askpass_prompt', (event) => {
      setPrompts((prev) => [...prev, event.payload]);
    });
    const unlistenExpired = listen<number>('git_askpass_expired', (event) => {
      setPrompts(prev => prev.filter(prompt => prompt.requestId !== event.payload));
    });
    return () => {
      void unlistenPrompt.then(fn => fn());
      void unlistenExpired.then(fn => fn());
    };
  }, []);

  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (prompts.length > 0 && !dialogRef.current?.open) {
      dialogRef.current?.showModal();
    }
  }, [prompts.length]);

  const current = prompts[0];
  useEffect(() => {
    if (current) passwordRef.current?.focus();
  }, [current?.requestId]);

  if (!current) return null;

  async function answer(password: string | null) {
    if (submitting) return;
    setSubmitting(true);
    try {
      await invoke('repository_provide_password', { requestId: current.requestId, password });
      setPrompts(prev => prev.slice(1));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void answer(passwordRef.current?.value ?? '');
  };
  const onCancel = () => { void answer(null); };
  const username = /username/i.test(current.prompt);

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-label="Authentication Required"
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
    >
      <div className="dialog-heading">
        <span className="dialog-icon">🔒</span>
        <button type="button" className="icon-button" aria-label="Cancel" disabled={submitting} onClick={onCancel}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <form onSubmit={onSubmit}>
        <h2>Authentication Required</h2>
        <p className="dialog-prompt">{current.prompt}</p>
        <div className="dialog-field">
          <label htmlFor="askpass-answer">
            {username ? 'Username' : 'Password or passphrase'}
          </label>
          <input
            key={current.requestId}
            id="askpass-answer"
            ref={passwordRef}
            type={username ? 'text' : 'password'}
            required
            autoComplete={username ? 'username' : 'current-password'}
            autoFocus
          />
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={submitting} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={submitting}>
            Submit
          </button>
        </div>
      </form>
    </dialog>
  );
}
