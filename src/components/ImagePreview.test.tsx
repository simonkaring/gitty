// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ImagePreview } from './ImagePreview';

it('shows image versions, falls back on decode errors, and lets SVGs show their source', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const before = { path: 'logo.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', error: null };
  const after = { ...before, dataUrl: 'data:image/svg+xml;base64,eA==' };
  try {
    await act(async () => root.render(<ImagePreview image={{ before, after, sourceDiff: true }}><p>SVG source</p></ImagePreview>));
    expect([...host.querySelectorAll('img')].map(img => [img.alt, img.src])).toEqual([
      ['Before: logo.svg', before.dataUrl],
      ['After: logo.svg', after.dataUrl],
    ]);
    await act(async () => { host.querySelector('img[alt^="After"]')!.dispatchEvent(new Event('error')); });
    expect(host.querySelector('[role="status"]')?.textContent).toContain('could not be displayed');
    expect(host.querySelectorAll('img')).toHaveLength(1);
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('SVG source');
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('img[alt^="Before"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
