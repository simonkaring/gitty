// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StartPage } from './Welcome';
import type { ProviderAccount, ProviderRepository, ProviderRepositoryPage } from '../model/providerRepositories';

const mocks = vi.hoisted(() => ({ native: vi.fn(), openSettings: vi.fn() }));
vi.mock('../model/native', () => ({ native: mocks.native, errorMessage: (e: unknown) => e instanceof Error ? e.message : String(e) }));
vi.mock('../model/settings', () => ({ useSettings: () => ({ openSettings: mocks.openSettings, isSettingsOpen: false }) }));

let container: HTMLDivElement;
let root: Root;
const onClone = vi.fn();
const accounts: ProviderAccount[] = [
  { id: 'github-user', provider: 'github', username: 'alice' },
  { id: 'gitlab-user', provider: 'gitlab', username: 'alice' },
  { id: 'azure-user', provider: 'azureDevops', username: 'alice@example.com', oauth: true },
];
const repository = (id: string, name: string, provider = 'github.com', project: string | null = null): ProviderRepository => ({ id, name, namespace: project ?? 'team', cloneUrl: `https://${provider}/team/${name}.git`, private: true, project });

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.native.mockReset(); mocks.openSettings.mockReset(); onClone.mockReset();
  mocks.native.mockImplementation(async (command: string, args?: { accountId?: string; cursor?: string }) => {
    if (command === 'list_provider_accounts') return accounts;
    if (command === 'repository_recent' || command === 'wsl_distributions') return [];
    if (command === 'repository_pick_clone_parent') return '/clones';
    if (command === 'provider_organizations') return ['org'];
    if (command === 'provider_repositories') return { repositories: [repository('repo', args?.accountId === 'gitlab-user' ? 'gitlab-repo' : 'repo', args?.accountId === 'gitlab-user' ? 'gitlab.com' : 'github.com')], nextCursor: null };
    throw new Error(`Unexpected command ${command}`);
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function mount() {
  await act(async () => root.render(<StartPage onOpen={() => {}} onClone={onClone} cloneBusy={false} />));
  await click('Clone');
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
function input(label: string) {
  return [...container.querySelectorAll('input')].find(value => value.getAttribute('aria-label') === label || value.closest('label')?.textContent === label)!;
}
async function enter(label: string, value: string) {
  await act(async () => { const element = input(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function select(label: string, value: string) {
  const element = [...container.querySelectorAll('select')].find(item => item.closest('label')?.textContent?.startsWith(label))!;
  await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function chooseRepo(name: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.provider-repository-list button')].find(value => value.querySelector('strong')?.textContent === name)!;
  await act(async () => button.click());
}

it('clones a selected private repository through its account with a credential-free URL', async () => {
  await mount();
  expect(mocks.native).toHaveBeenCalledWith('provider_repositories', { accountId: 'github-user', organization: null, cursor: null });
  await chooseRepo('repo'); await click('Choose…'); await click('Clone repository');
  expect(onClone).toHaveBeenCalledWith({ source: 'https://github.com/team/repo.git', parent: { kind: 'native', path: '/clones' }, directoryName: 'repo', accountId: 'github-user' });
  expect(container.textContent).toContain('Private');
});

it('retains URL cloning without attaching a connected account', async () => {
  await mount(); await chooseRepo('repo');
  await click('Repository URL');
  expect(input('Repository URL').value).toBe('');
  await enter('Repository URL', 'https://example.test/team/manual.git');
  await enter('Folder name', 'manual'); await click('Choose…'); await click('Clone repository');
  expect(onClone).toHaveBeenCalledWith({ source: 'https://example.test/team/manual.git', parent: { kind: 'native', path: '/clones' }, directoryName: 'manual' });
});

it('loads more repositories and filters the accumulated pages by namespace or name', async () => {
  const base = mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation(async (command, args) => command === 'provider_repositories'
    ? { repositories: args.cursor ? [repository('two', 'second')] : [repository('one', 'first')], nextCursor: args.cursor ? null : '2' }
    : base(command, args));
  await mount(); await enter('Filter repositories', 'second');
  expect(container.textContent).toContain('No loaded repositories match');
  await click('Load more repositories'); await chooseRepo('second');
  expect(input('Repository URL').value).toBe('https://github.com/team/second.git');
  expect(mocks.native).toHaveBeenCalledWith('provider_repositories', { accountId: 'github-user', organization: null, cursor: '2' });
});

it('ignores an old account response after switching to another account', async () => {
  let resolve!: (page: ProviderRepositoryPage) => void;
  const pending = new Promise<ProviderRepositoryPage>(done => { resolve = done; });
  const base = mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation((command, args) => command === 'provider_repositories' && args.accountId === 'github-user' ? pending : base(command, args));
  await mount(); await select('Connected account', 'gitlab-user');
  await chooseRepo('gitlab-repo');
  await act(async () => resolve({ repositories: [repository('old', 'old-repo')], nextCursor: null }));
  expect(container.textContent).not.toContain('old-repo');
  expect(input('Repository URL').value).toBe('https://gitlab.com/team/gitlab-repo.git');
});

it('browses Azure organizations and filters repositories by project', async () => {
  const base = mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation(async (command, args) => command === 'provider_repositories' && args.accountId === 'azure-user'
    ? { repositories: [{ ...repository('one', 'one', 'dev.azure.com', 'Project One'), cloneUrl: 'https://dev.azure.com/org/Project%20One/_git/one' }, { ...repository('two', 'two', 'dev.azure.com', 'Project Two'), cloneUrl: 'https://dev.azure.com/org/Project%20Two/_git/two' }], nextCursor: null }
    : base(command, args));
  await mount(); await chooseRepo('repo'); await select('Connected account', 'azure-user');
  expect(input('Repository URL').value).toBe('');
  expect(mocks.native).toHaveBeenCalledWith('provider_organizations', { accountId: 'azure-user' });
  expect(mocks.native).toHaveBeenCalledWith('provider_repositories', { accountId: 'azure-user', organization: 'org', cursor: null });
  await select('Project', 'Project Two');
  expect(container.querySelectorAll('.provider-repository-list button')).toHaveLength(1);
  await chooseRepo('two'); await click('Choose…'); await click('Clone repository');
  expect(onClone.mock.calls[0][0].accountId).toBe('azure-user');
});

it('allows manual Azure organization selection when discovery fails', async () => {
  const base = mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation(async (command, args) => { if (command === 'provider_organizations') throw new Error('Permission denied'); return base(command, args); });
  await mount(); await select('Connected account', 'azure-user');
  expect(container.textContent).toContain('You can enter an organization name below');
  const element = container.querySelector<HTMLInputElement>('input[placeholder="your-organization"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, 'my-org'); element.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Use organization');
  expect(mocks.native).toHaveBeenCalledWith('provider_repositories', { accountId: 'azure-user', organization: 'my-org', cursor: null });
});

it('links to account settings and surfaces API errors with retry', async () => {
  const base = mocks.native.getMockImplementation()!;
  let attempts = 0;
  mocks.native.mockImplementation(async (command, args) => { if (command === 'provider_repositories' && attempts++ === 0) throw new Error('Token expired'); return base(command, args); });
  await mount(); expect(container.textContent).toContain('Token expired');
  await click('Retry'); await chooseRepo('repo');
  await click('Manage accounts…'); expect(mocks.openSettings).toHaveBeenCalledWith('Integrations');
});
