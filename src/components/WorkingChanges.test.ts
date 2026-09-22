import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import { DiffPreview } from './WorkingChanges';
import type { FileDiff } from '../model/repository';

const diff: FileDiff = {
  path: 'file.txt', binary: false, truncated: false, message: null,
  hunkAction: { fingerprint: 'backend-token', reason: null },
  hunks: [0, 1].map(i => ({ header: `@@ -${i * 20 + 1},1 +${i * 20 + 1},1 @@`, lines: [{ kind: 'add', content: 'changed', oldLine: null, newLine: i * 20 + 1 }] })),
};
// DiffPreview is a pure component: inspect its real element callbacks, while
// static rendering checks accessible labels and both display modes without a DOM shim.
function buttons(node: ReactNode): ReactElement<{ disabled: boolean; onClick: () => void; children: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return element.type === 'button' ? [element as ReturnType<typeof buttons>[number]] : buttons(element.props.children);
}
describe('hunk preview actions', () => {
  it.each([false, true])('routes the selected complete hunk in split=%s', split => {
    for (const kind of ['stage_hunk', 'unstage_hunk'] as const) {
      const onHunk = vi.fn();
      const tree = DiffPreview({ diff, split, hunkAction: kind, onHunk });
      const actions = buttons(tree);
      expect(actions).toHaveLength(2);
      actions[1].props.onClick();
      expect(onHunk).toHaveBeenCalledExactlyOnceWith({ kind, path: 'file.txt', hunkIndex: 1, fingerprint: 'backend-token' });
      const html = renderToStaticMarkup(tree);
      expect(html).toContain(`${kind === 'stage_hunk' ? 'Stage' : 'Unstage'} hunk 2 in file.txt`);
      expect(html).toContain(split ? 'split-row' : 'line-number');
    }
  });
  it.each([
    { busy: true },
    { unavailable: 'Unavailable in demo. Open a desktop repository.' },
    { diff: { ...diff, truncated: true } },
    { diff: { ...diff, binary: true } },
    { diff: { ...diff, hunkAction: null } },
    { diff: { ...diff, hunkAction: { fingerprint: null, reason: 'Use whole-file staging for renames.' } } },
  ])('disables and guards unavailable actions: %j', overrides => {
    const onHunk = vi.fn();
    const tree = DiffPreview({ diff, split: false, hunkAction: 'stage_hunk', onHunk, ...overrides });
    for (const action of buttons(tree)) { expect(action.props.disabled).toBeTruthy(); action.props.onClick(); }
    expect(onHunk).not.toHaveBeenCalled();
    if (!('busy' in overrides)) expect(renderToStaticMarkup(tree)).toContain('hunk-unavailable');
  });
  it('keeps historical and untracked previews read-only', () => {
    expect(buttons(DiffPreview({ diff, split: false }))).toEqual([]);
  });
});
