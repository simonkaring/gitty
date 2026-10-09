// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SettingsDialog } from './Settings';
import { SettingsProvider, useSettings } from '../model/settings';

vi.mock('./IntegrationsSettings', () => ({ IntegrationsSettings: () => null }));

it('offers demo switching in About settings, blocks busy workspaces, and closes settings on switch', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const toggle = vi.fn();
  function Harness({ busy }: { busy: boolean }) { const api = useSettings(); return <><button onClick={() => api.openSettings()}>Open</button><SettingsDialog demo={false} demoBusy={busy} onToggleDemo={toggle} /></>; }
  const render = (busy: boolean) => root.render(<SettingsProvider><Harness busy={busy} /></SettingsProvider>);
  try {
    await act(async () => render(true));
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'About / shortcuts')!.click());
    const button = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Explore demo workspace')!;
    expect(button().disabled).toBe(true);
    await act(async () => render(false));
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(toggle).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog[open]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
