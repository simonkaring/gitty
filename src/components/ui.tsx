import { createContext, useContext, useEffect, useId, useRef, type FormEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Shared UI primitives: one dialog frame, one popover dismissal, one toast region. */

/** Closes a popover on outside pointerdown (ignoring `inside` elements, e.g. its
 * trigger) or Escape, then returns focus to `returnTo`. */
export function useDismiss(open: boolean, onClose: () => void, inside: RefObject<HTMLElement | null>[], returnTo?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (!inside.some(ref => ref.current?.contains(event.target as Node))) close.current(); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      close.current(); returnTo?.current?.focus();
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key, true); };
  }, [open]); // refs are stable; onClose is read through `close`
}

/** Modal frame: title + close, scrolling body, optional footer action row.
 * With `onSubmit`, body and footer form one <form> so footer buttons submit.
 * Escape and the close button call `onClose`; the backdrop does not, so a
 * stray click never discards typed input. */
export function Dialog({ title, onClose, size = 'md', footer, onSubmit, className = '', children, label }: {
  title: ReactNode; onClose: () => void; size?: 'sm' | 'md' | 'lg'; footer?: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void; className?: string; children: ReactNode; label?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!ref.current?.open) ref.current?.showModal();
    return () => previous?.focus({ preventScroll: true });
  }, []);
  const content = <>
    <div className="dialog-body">{children}</div>
    {footer && <footer className="dialog-footer">{footer}</footer>}
  </>;
  return <dialog ref={ref} className={`dialog dialog-${size} ${className}`} aria-labelledby={label ? undefined : titleId} aria-label={label} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="dialog-header">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={16} /></button>
    </header>
    {onSubmit ? <form className="dialog-form" onSubmit={event => { event.preventDefault(); onSubmit(event); }}>{content}</form> : content}
  </dialog>;
}

const ToastRoot = createContext<HTMLElement | null>(null);
/** The single bottom-right notification region for the whole window. */
export function ToastRegion({ onMount }: { onMount: (element: HTMLElement | null) => void }) {
  return <div className="toast-region" ref={onMount} />;
}
export const ToastProvider = ToastRoot.Provider;

/** A notification rendered into the window's toast region. Errors stay until
 * dismissed or acted on; callers own timers for transient notices. */
export function Toast({ tone = 'info', action, onDismiss, children }: { tone?: 'info' | 'error' | 'progress'; action?: ReactNode; onDismiss?: () => void; children: ReactNode }) {
  const root = useContext(ToastRoot);
  if (!root) return null;
  return createPortal(<div className="toast" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
    <div className="toast-body">{children}</div>
    {action}
    {onDismiss && <button type="button" className="icon-button sm" aria-label="Dismiss notification" onClick={onDismiss}><X size={14} /></button>}
  </div>, root);
}

/** Two-or-more-way toggle (e.g. Unified / Side by side). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (value: T) => void; label: string }) {
  return <div className="segmented" role="group" aria-label={label}>
    {options.map(([id, text]) => <button type="button" key={id} aria-pressed={value === id} onClick={() => onChange(id)}>{text}</button>)}
  </div>;
}
