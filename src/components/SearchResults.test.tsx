// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SearchResults } from './SearchResults';

it('opens results separately from graph reveal, highlights literal text, and supports keyboard navigation', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const onSelect = vi.fn(), onReveal = vi.fn();
  const commits = ['abcdef1', 'abcdef2'].map(id => ({ id, subject: 'Fix [search] and [search] again', author: 'Ada', email: 'ada@example.com', parents: [], timestamp: 100 }));
  try {
    await act(async () => root.render(<SearchResults result={{ commits, truncated: true }} loading={false} error="" query="[search]" refs={[]} selected="abcdef2" onSelect={onSelect} onReveal={onReveal} onRetry={() => {}} onClear={() => {}} />));
    const buttons = host.querySelectorAll<HTMLButtonElement>('.search-result-select');
    expect(host.querySelectorAll('mark')).toHaveLength(4);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    await act(async () => buttons[0].click());
    expect(onSelect).toHaveBeenCalledWith('abcdef1');
    expect(onReveal).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('.search-result-reveal')!.click());
    expect(onReveal).toHaveBeenCalledWith('abcdef1');
    buttons[0].focus();
    await act(async () => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(buttons[1]);
    expect(host.textContent).toContain('Showing the first 2 matches');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('shows loading, empty, and retry states without misleading empty results during loading', async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  const onRetry = vi.fn(), onClear = vi.fn();
  const props = { query: '', refs: [], selected: '', onSelect() {}, onReveal() {}, onRetry, onClear };
  try {
    await act(async () => root.render(<SearchResults {...props} result={null} loading error="" />));
    expect(host.textContent).toContain('Searching full history');
    expect(host.textContent).not.toContain('No matching commits');
    await act(async () => root.render(<SearchResults {...props} result={null} loading={false} error="Request timed out" />));
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(onRetry).toHaveBeenCalledOnce();
    await act(async () => root.render(<SearchResults {...props} result={{ commits: [], truncated: false }} loading={false} error="" />));
    expect(host.textContent).toContain('No matching commits');
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(onClear).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});
