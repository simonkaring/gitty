const TARGETS = 'button:not(:disabled), summary, .palette-item';

/** Material press ripple: records the pointer origin; CSS animates it via [data-ripple]. */
export function attachRipple(root: Document = document): () => void {
  const down = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>(TARGETS);
    if (!el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    el.style.setProperty('--rx', `${x}px`);
    el.style.setProperty('--ry', `${y}px`);
    el.style.setProperty('--rmax', `${Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y))}px`);
    el.removeAttribute('data-ripple');
    void el.offsetWidth;
    el.setAttribute('data-ripple', '');
  };
  const end = (e: AnimationEvent) => { if (e.animationName === 'm-ripple') (e.target as Element).removeAttribute('data-ripple'); };
  root.addEventListener('pointerdown', down, true);
  root.addEventListener('animationend', end, true);
  return () => { root.removeEventListener('pointerdown', down, true); root.removeEventListener('animationend', end, true); };
}
