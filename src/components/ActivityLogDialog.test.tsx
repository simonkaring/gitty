// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLogDialog } from './ActivityLogDialog';
import { clearActivityLog, recordCommandEnd, recordCommandStart, recordGitCommand } from '../model/activity';

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  clearActivityLog();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() { this.setAttribute('open', ''); },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  clearActivityLog();
});

describe('ActivityLogDialog', () => {
  it('renders recorded activities and formats status and command', async () => {
    const id1 = recordCommandStart('repository_stage', { paths: ['src/App.tsx'] });
    recordCommandEnd(id1, 'success', 15);
    const id2 = recordCommandStart('repository_create_commit', { message: 'feat: add stuff' });
    recordCommandEnd(id2, 'error', 120, 'Pre-commit hook failed');

    await act(async () => {
      root.render(<ActivityLogDialog onClose={vi.fn()} />);
    });

    expect(container.textContent).toContain('Activity log');
    expect(container.textContent).toContain('repository_stage');
    expect(container.textContent).toContain('repository_create_commit');
    expect(container.textContent).toContain('15ms');
    expect(container.textContent).toContain('Pre-commit hook failed');
  });

  it('shows everything inline, in full, oldest first, like a console', async () => {
    const message = 'fix: tidy\n\nlong body line one\nlong body line two';
    recordGitCommand({ command: 'git add --all --pathspec-from-file=-', stdin: 'src/a b.ts\nsrc/deep/c.ts', success: true, code: 0, millis: 4 });
    recordGitCommand({ command: 'git commit --quiet --file=-', stdin: message, success: false, code: 1, millis: 90 });
    const longPath = 'p/'.repeat(300);
    recordCommandEnd(recordCommandStart('repository_stage', { paths: [longPath] }), 'success', 2);

    await act(async () => { root.render(<ActivityLogDialog onClose={vi.fn()} />); });

    expect(container.querySelector('details')).toBeNull();
    const text = container.textContent!;
    expect(text).toContain('src/a b.ts');
    expect(text).toContain('src/deep/c.ts');
    expect([...container.querySelectorAll('.console-row[data-label="stdin"] pre')].map(pre => pre.textContent)).toEqual(['src/a b.ts\nsrc/deep/c.ts', message]);
    expect(text).toContain(longPath);
    expect(text.indexOf('git add')).toBeLessThan(text.indexOf('git commit'));
    expect(text.indexOf('git commit')).toBeLessThan(text.indexOf('repository_stage'));
    expect(container.querySelectorAll('.console-prompt')[0].textContent).toBe('$');
    expect(container.querySelectorAll('.console-prompt')[2].textContent).toBe('>');
  });

  it('filter also searches paths and commit messages', async () => {
    recordGitCommand({ command: 'git commit --quiet --file=-', stdin: 'feat: needle in message', success: true, code: 0, millis: 1 });
    recordGitCommand({ command: 'git add --all --pathspec-from-file=-', stdin: 'src/other.ts', success: true, code: 0, millis: 1 });

    await act(async () => { root.render(<ActivityLogDialog onClose={vi.fn()} />); });
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain('needle in message');
    expect(container.textContent).not.toContain('src/other.ts');
  });

  it('filters activities based on search input', async () => {
    const id1 = recordCommandStart('repository_stage', { paths: ['a.txt'] });
    recordCommandEnd(id1, 'success', 10);
    const id2 = recordCommandStart('repository_run_operation', { request: { action: { kind: 'switchBranch', branch: 'main' } } });
    recordCommandEnd(id2, 'success', 20);

    await act(async () => {
      root.render(<ActivityLogDialog onClose={vi.fn()} />);
    });

    const searchInput = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(searchInput, 'operation');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).toContain('repository_run_operation');
    expect(container.textContent).not.toContain('repository_stage');
  });

  it('clears activities when Clear is clicked', async () => {
    const id = recordCommandStart('repository_create_commit', { message: 'initial commit' });
    recordCommandEnd(id, 'success', 5);

    await act(async () => {
      root.render(<ActivityLogDialog onClose={vi.fn()} />);
    });
    expect(container.textContent).toContain('repository_create_commit');

    const clearBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Clear'))!;
    await act(async () => {
      clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('No activity recorded yet.');
  });

  it('copies activity logs to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    const id = recordCommandStart('repository_open', { location: { path: '/tmp/repo' } });
    recordCommandEnd(id, 'success', 50);

    await act(async () => {
      root.render(<ActivityLogDialog onClose={vi.fn()} />);
    });

    const copyBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Copy'))!;
    await act(async () => {
      copyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain('SUCCESS repository_open');
  });

  it('copies stdin and full args too', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    recordGitCommand({ command: 'git commit --quiet --file=-', stdin: 'subject\n\nbody', success: true, code: 0, millis: 12 });

    await act(async () => { root.render(<ActivityLogDialog onClose={vi.fn()} />); });
    const copyBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Copy'))!;
    await act(async () => { copyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(writeText.mock.calls[0][0]).toMatch(/SUCCESS git commit --quiet --file=- \(12ms\)\n  stdin: subject\n    \n    body/);
  });
});
