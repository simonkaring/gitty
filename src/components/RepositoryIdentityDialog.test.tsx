// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RepositoryIdentityButton } from './RepositoryIdentityButton';

const invoke = vi.hoisted(() => vi.fn());
const avatars = vi.hoisted(() => ({
  mode: 'initials' as 'initials' | 'gravatar',
  url: vi.fn(async (_email: string) => 'https://gravatar.com/avatar/mock'),
}));
const github = vi.hoisted(() => ({ id: 'github-12345678-1234-1234-1234-123456789abc', name: 'octocat', email: '123+octocat@users.noreply.github.com' }));
vi.mock('../model/native', () => ({ native: invoke, errorMessage: (e: Error) => e.message }));
vi.mock('../model/settings', () => ({ useSettings: () => ({ settings: { authorAvatarMode: avatars.mode, commitProfiles: [{ id: 'profile-1', name: 'Repo Author', email: 'repo@example.org' }] }, githubCommitProfiles: [github], openSettings: vi.fn() }) }));
vi.mock('../model/gravatar', () => ({ gravatarUrl: avatars.url, gravatarImageFailed: () => false, markGravatarImageFailed: vi.fn() }));

it('uses the effective email for Gravatar only when enabled and falls back to initials', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'), root = createRoot(host);
  const render = () => act(async () => { root.render(<RepositoryIdentityButton handle="repo" active busy={false} revision={0} refresh={0} onApply={async () => {}} />); });
  invoke.mockReset().mockResolvedValue({
    local: { name: 'Repo Name', email: 'repo@example.org' },
    effective: { name: 'Effective Name', email: 'worktree@example.org' },
    effectiveSources: { name: 'worktree', email: 'worktree' },
  });
  try {
    await render();
    expect(host.querySelector('.repository-identity-avatar')?.textContent).toBe('EN');
    expect(avatars.url).not.toHaveBeenCalled();
    avatars.mode = 'gravatar';
    await render();
    expect(avatars.url).toHaveBeenCalledExactlyOnceWith('worktree@example.org');
    const image = host.querySelector('img')!;
    expect(image.src).toBe('https://gravatar.com/avatar/mock');
    await act(async () => { image.dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.repository-identity-avatar')?.textContent).toBe('EN');
  } finally { avatars.mode = 'initials'; await act(async () => { root.unmount(); }); }
});

it.each([{ id: 'profile-1', name: 'Repo Author', email: 'repo@example.org' }, github])('rereads the effective identity after applying $name', async ({ id, name, email }) => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  const identity = { local: { name: 'Old Name', email: 'old@example.org' }, effective: { name: 'Old Name', email: 'worktree@example.org' }, effectiveSources: { name: 'repository', email: 'worktree' } };
  invoke.mockReset().mockResolvedValue(identity);
  const onApply = vi.fn(async () => {
    invoke.mockResolvedValue({ ...identity, local: { name, email }, effective: { ...identity.effective, name } });
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<RepositoryIdentityButton handle="repo" active busy={false} revision={0} refresh={0} onApply={onApply} />); });
    expect(invoke).toHaveBeenCalledWith('repository_git_identity', { handle: 'repo' });
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Git identity…"]')!;
    const preview = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(preview.hidden).toBe(true);
    await act(async () => { trigger.focus(); });
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toContain('Old Name · worktree@example.org');
    expect(preview.textContent).toContain('Name: Repository config · Email: Worktree config');
    expect(preview.textContent).toContain('Repository config: Old Name · old@example.org');
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(preview.hidden).toBe(true);
    await act(async () => { trigger.click(); });
    const select = host.querySelector('select')!;
    await act(async () => { select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onApply).not.toHaveBeenCalled();
    await act(async () => { ([...host.querySelectorAll('button')].find(button => button.textContent === 'Apply to repository') as HTMLButtonElement).click(); });
    expect(onApply).toHaveBeenCalledWith({ name, email }, identity.local);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(preview.textContent).toContain(`${name} · worktree@example.org`);
  } finally { await act(async () => { root.unmount(); }); host.remove(); }
});
