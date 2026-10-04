import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDismiss } from './ui';

export interface MenuAnchor { x: number; y: number; trigger: HTMLElement }

/** Shared behavior of a right-click menu: clamp it inside the viewport, focus the first
 * item, roving arrow/Home/End focus, Tab closes, and outside click or Escape dismisses
 * and returns focus to the element that opened it. Attach `menu` to the `role="menu"` box. */
export function useContextMenu(target: MenuAnchor, onClose: () => void) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });
  useLayoutEffect(() => {
    const rect = menu.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(4, Math.min(target.x, window.innerWidth - rect.width - 4)), top: Math.max(4, Math.min(target.y, window.innerHeight - rect.height - 4)) });
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [target]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Tab') onClose();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && menu.current?.contains(document.activeElement)) {
        event.preventDefault();
        const items = [...menu.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [onClose, target]);
  const trigger = useRef<HTMLElement | null>(target.trigger);
  trigger.current = target.trigger;
  useDismiss(true, onClose, [menu], trigger);
  return { menu, position };
}
