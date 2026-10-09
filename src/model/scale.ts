import { useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

export const SCALES = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300] as const;
const KEY = 'gitty:scale';

export function applyScale(percent: number) {
  // Native webview zoom behaves like browser zoom (no extra scrollbars); CSS zoom is the browser-preview fallback.
  if (isTauri()) void getCurrentWebview().setZoom(percent / 100).catch(() => {});
  else { document.documentElement.style.zoom = String(percent / 100); document.documentElement.style.setProperty('--zoom', String(percent / 100)); }
  try { localStorage.setItem(KEY, String(percent)); } catch { /* ponytail: session-only if storage is unavailable */ }
}

export function loadScale(): number {
  try { const n = Number(localStorage.getItem(KEY)); return (SCALES as readonly number[]).includes(n) ? n : 100; } catch { return 100; }
}

// One owner for the interface zoom: it drives the whole webview, so every mounted
// repository pane must show (and change) the same value.
let current: number | null = null;
const listeners = new Set<() => void>();
const getScale = () => (current ??= loadScale());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Applies a zoom level and notifies every `useScale` consumer. */
export function setScale(percent: number) {
  current = percent;
  applyScale(percent);
  listeners.forEach(listener => listener());
}

/** Shared zoom value plus a setter that applies it to the webview. */
export function useScale(): [number, (percent: number) => void] {
  return [useSyncExternalStore(subscribe, getScale, getScale), setScale];
}
