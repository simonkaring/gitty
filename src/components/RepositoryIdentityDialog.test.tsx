// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RepositoryIdentityDialog } from './RepositoryIdentityDialog';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: invoke, errorMessage: (e: Error) => e.message }));
vi.mock('../model/settings', () => ({ useSettings: () => ({ settings: { commitProfiles: [{ id: 'profile-1', name: 'Repo Author', email: 'repo@example.org' }] }, openSettings: vi.fn() }) }));

it('reads repository identity and applies a selected profile only on explicit confirmation', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  const identity = { local: { name: 'Old Name', email: 'old@example.org' }, effective: { name: 'Old Name', email: 'old@example.org' } };
  invoke.mockResolvedValue(identity);
  const onApply = vi.fn(async () => {});
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<RepositoryIdentityDialog handle="repo" revision={0} onApply={onApply} onClose={() => {}} />); });
    expect(invoke).toHaveBeenCalledWith('repository_git_identity', { handle: 'repo' });
    expect(host.textContent).toContain('Old Name');
    const select = host.querySelector('select')!;
    await act(async () => { select.value = 'profile-1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onApply).not.toHaveBeenCalled();
    await act(async () => { ([...host.querySelectorAll('button')].find(button => button.textContent === 'Apply to repository') as HTMLButtonElement).click(); });
    expect(onApply).toHaveBeenCalledWith({ name: 'Repo Author', email: 'repo@example.org' }, identity.local);
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally { await act(async () => { root.unmount(); }); }
});
