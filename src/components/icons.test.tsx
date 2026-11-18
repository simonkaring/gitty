// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icons } from './icons';

afterEach(() => delete document.documentElement.dataset.design);

it('renders SF Symbols-style glyphs at 1.8 stroke in the Apple design only', () => {
  document.documentElement.dataset.design = 'default';
  const lucide = renderToStaticMarkup(<Icons.GitBranch size={14} className="current-branch-check" />);
  document.documentElement.dataset.design = 'apple';
  const apple = renderToStaticMarkup(<Icons.GitBranch size={14} className="current-branch-check" />);
  expect(apple).toContain('stroke-width="1.8"');
  expect(apple).toContain('width="14"');
  // Sidebar hover animations target the lucide-* marker, so the Apple glyph keeps it beside the caller's class.
  expect(apple).toContain('lucide-git-branch');
  expect(apple).toContain('current-branch-check');
  expect(apple).toContain('<circle cx="6.5" cy="5.5" r="2.2"/>');
  expect(lucide).not.toContain('stroke-width="1.8"');
  expect(lucide).toContain('lucide-git-branch');
});
