import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Dialog } from './ui';

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
      setPrompts(prev => prev.filter(prompt => prompt.requestId !== current.requestId));
      setError('');
    } catch (e) {
      if (password === null) {
        setPrompts(prev => prev.filter(prompt => prompt.requestId !== current.requestId));
        setError('');
      } else {
        setError(String(e));
      }
    } finally {
      setSubmitting(false);
    }
  }
  const onSubmit = () => {
    void answer(passwordRef.current?.value ?? '');
  };
  const onCancel = () => { void answer(null); };
  const username = /username/i.test(current.prompt);

  const secretLabel = username ? 'Username' : /github\.com/i.test(current.prompt) ? 'Personal access token' : 'Token or SSH passphrase';
  return <Dialog title="Authentication required" size="sm" onClose={onCancel} onSubmit={onSubmit} footer={<>
    <button type="button" className="secondary-button" disabled={submitting} onClick={onCancel}>Cancel</button>
    <button type="submit" className="primary-button" disabled={submitting}>Submit</button>
  </>}>
    <p className="muted">{current.prompt}</p>
    <label className="field">{secretLabel}
      <input key={current.requestId} ref={passwordRef} type={username ? 'text' : 'password'} required autoComplete={username ? 'username' : 'current-password'} autoFocus />
    </label>
    {!username && /github\.com/i.test(current.prompt) && <p className="muted">GitHub does not accept your account password for Git. Use a personal access token, or connect an account in Settings → Integrations.</p>}
    {error && <p className="alert" role="alert">{error}</p>}
  </Dialog>;
}
