import { useEffect, useRef, useState } from 'react';
import { FolderGit2, Lock, Search } from 'lucide-react';
import { errorMessage, native } from '../model/native';
import { useSettings } from '../model/settings';
import { REPOSITORY_PROVIDER_LABELS, type ProviderAccount, type ProviderRepository, type ProviderRepositoryPage, type RepositoryProvider } from '../model/providerRepositories';

type SelectRepository = (repository: ProviderRepository | null, accountId?: string) => void;

export function RepositoryBrowser({ disabled, onSelect }: { disabled: boolean; onSelect: SelectRepository }) {
  const { openSettings, isSettingsOpen } = useSettings();
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (isSettingsOpen) return;
    let live = true;
    onSelect(null); setLoading(true); setError('');
    void native<ProviderAccount[]>('list_provider_accounts').then(values => {
      if (!live) return;
      const supported = values.filter(account => account.provider !== 'bitbucket');
      setAccounts(supported);
      setAccountId(previous => supported.some(account => account.id === previous) ? previous : supported[0]?.id ?? '');
    }).catch(e => { if (live) { setError(errorMessage(e)); setAccounts([]); setAccountId(''); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [isSettingsOpen, refresh, onSelect]);
  useEffect(() => { onSelect(null); }, [accountId, onSelect]);
  const account = accounts.find(value => value.id === accountId);
  return <div className="repository-browser">
    <div className="repository-browser-toolbar">
      <label className="field">Connected account<select disabled={disabled || loading || !accounts.length} value={accountId} onChange={e => { onSelect(null); setAccountId(e.target.value); }}>
        {!accounts.length && <option value="">No connected accounts</option>}
        {accounts.map(value => <option key={value.id} value={value.id}>{REPOSITORY_PROVIDER_LABELS[value.provider as RepositoryProvider]} · {value.username}</option>)}
      </select></label>
      <button type="button" className="text-button" disabled={disabled} onClick={() => openSettings('Integrations')}>Manage accounts…</button>
      <button type="button" className="text-button" disabled={disabled || loading} onClick={() => setRefresh(value => value + 1)}>Refresh accounts</button>
    </div>
    {loading && <p className="muted small" role="status">Reading connected accounts…</p>}
    {error && <p className="alert" role="alert">{error}</p>}
    {!loading && !error && !accounts.length && <p className="muted small">Connect GitHub, GitLab.com, or Azure DevOps in Integrations to browse your repositories.</p>}
    {account && !loading && <AccountRepositories key={account.id} account={account} disabled={disabled} onSelect={onSelect} />}
  </div>;
}

function AccountRepositories({ account, disabled, onSelect }: { account: ProviderAccount; disabled: boolean; onSelect: SelectRepository }) {
  const azure = account.provider === 'azureDevops';
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [organization, setOrganization] = useState('');
  const [manualOrganization, setManualOrganization] = useState('');
  const [loading, setLoading] = useState(azure);
  const [error, setError] = useState('');
  const organizationGeneration = useRef(0);
  useEffect(() => {
    if (!azure) return;
    const generation = ++organizationGeneration.current;
    void native<string[]>('provider_organizations', { accountId: account.id }).then(values => {
      if (organizationGeneration.current !== generation) return;
      setOrganizations(values); setOrganization(values[0] ?? '');
    }).catch(e => { if (organizationGeneration.current === generation) setError(`${errorMessage(e)} You can enter an organization name below.`); })
      .finally(() => { if (organizationGeneration.current === generation) setLoading(false); });
    return () => { organizationGeneration.current++; };
  }, [account.id, azure]);
  function chooseOrganization(value: string) {
    organizationGeneration.current++; setLoading(false); setError('');
    onSelect(null); setOrganization(value);
  }
  function useOrganization() {
    const value = manualOrganization.trim();
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(value)) { setError('Enter an organization name, not a URL.'); return; }
    setOrganizations(previous => previous.includes(value) ? previous : [...previous, value]);
    chooseOrganization(value);
  }
  return <>
    {azure && <>
      {!!organizations.length && <label className="field">Organization<select value={organization} disabled={disabled} onChange={e => chooseOrganization(e.target.value)}>{organizations.map(name => <option key={name}>{name}</option>)}</select></label>}
      <label className="field">Organization name<div className="field-row"><input value={manualOrganization} disabled={disabled} placeholder="your-organization" onChange={e => setManualOrganization(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); useOrganization(); } }} /><button type="button" className="secondary-button" disabled={disabled || !manualOrganization.trim()} onClick={useOrganization}>Use organization</button></div></label>
      {loading && <p className="muted small" role="status">Reading Azure DevOps organizations…</p>}
      {error && <p className="alert" role="alert">{error}</p>}
      {!loading && !organization && !error && <p className="muted small">Enter an organization name to browse its repositories.</p>}
    </>}
    {(!azure || organization) && <RepositoryList key={`${account.id}:${organization}`} accountId={account.id} organization={azure ? organization : undefined} disabled={disabled} onSelect={onSelect} />}
  </>;
}

function RepositoryList({ accountId, organization, disabled, onSelect }: { accountId: string; organization?: string; disabled: boolean; onSelect: SelectRepository }) {
  const [repositories, setRepositories] = useState<ProviderRepository[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [project, setProject] = useState('');
  const [selected, setSelected] = useState('');
  const request = useRef(0);
  async function load(next: string | null = null) {
    const generation = ++request.current; setLoading(true); setError('');
    try {
      const page = await native<ProviderRepositoryPage>('provider_repositories', { accountId, organization: organization ?? null, cursor: next });
      if (request.current !== generation) return;
      setRepositories(previous => {
        const values = next ? previous : [];
        const ids = new Set(values.map(value => value.id));
        return [...values, ...page.repositories.filter(value => !ids.has(value.id))];
      });
      setCursor(page.nextCursor);
    } catch (e) { if (request.current === generation) setError(errorMessage(e)); }
    finally { if (request.current === generation) setLoading(false); }
  }
  useEffect(() => {
    onSelect(null); void load();
    return () => { request.current++; };
    // This component is keyed by account and organization; requests expire on unmount.
  }, []);
  const query = filter.trim().toLowerCase();
  const shown = repositories.filter(repo => (!project || repo.project === project) && (!query || `${repo.namespace}/${repo.name}`.toLowerCase().includes(query)));
  const projects = [...new Set(repositories.flatMap(repo => repo.project ? [repo.project] : []))].sort();
  return <>
    {!!organization && !!projects.length && <label className="field">Project<select value={project} disabled={disabled} onChange={e => { setProject(e.target.value); setSelected(''); onSelect(null); }}><option value="">All projects</option>{projects.map(name => <option key={name}>{name}</option>)}</select></label>}
    <label className="search-field"><Search size={14} aria-hidden="true" /><input aria-label="Filter repositories" placeholder="Filter repositories by name or namespace" value={filter} disabled={disabled} onChange={e => setFilter(e.target.value)} /></label>
    <ul className="start-list provider-repository-list" aria-label="Provider repositories" aria-busy={loading}>
      {shown.map(repo => <li key={repo.id}><button type="button" className="start-item" aria-pressed={selected === repo.id} disabled={disabled} onClick={() => { setSelected(repo.id); onSelect(repo, accountId); }}>
        <FolderGit2 size={16} /><span><strong>{repo.name}</strong><small>{repo.namespace}</small></span>
        {repo.private && <span className="badge"><Lock size={11} aria-hidden="true" />Private</span>}
      </button></li>)}
    </ul>
    {loading && <p className="muted small" role="status">Reading repositories…</p>}
    {!loading && !error && !shown.length && <p className="muted small">{repositories.length ? 'No loaded repositories match this filter.' : 'No repositories are available to this account.'}</p>}
    {error && <p className="alert" role="alert">{error} <button type="button" className="text-button" disabled={disabled} onClick={() => void load(cursor)}>Retry</button></p>}
    {cursor && <div className="repository-browser-toolbar"><p className="muted small">Filtering {repositories.length} loaded repositories.</p><button type="button" className="secondary-button compact" disabled={disabled || loading} onClick={() => void load(cursor)}>Load more repositories</button></div>}
  </>;
}
