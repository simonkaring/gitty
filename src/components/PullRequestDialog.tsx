import { useEffect, useRef, useState } from 'react';
import type { RemoteInfo } from '../model/operations';
import { native, errorMessage } from '../model/native';
import { pullRequestUrl } from '../model/pullRequest';
import { Dialog } from './ui';

interface ProviderAccount { id: string; provider: 'github' | 'gitlab' | 'azureDevops' | 'bitbucket'; username: string }
interface ProviderPullRequest { id: string; title: string; url: string; source: string; target: string; state: string }

export function PullRequestDialog({ handle, source, onClose }: { handle: string; source: string; onClose: () => void }) {
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [remote, setRemote] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const opening = useRef(false);
  const alive = useRef(true);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [requests, setRequests] = useState<ProviderPullRequest[]>([]);
  const [requestTitle, setRequestTitle] = useState('');
  const [description, setDescription] = useState('');
  const [loadingRequests, setLoadingRequests] = useState(false);
  const branch = source.replace(/^refs\/heads\//, '');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { let live = true; setLoading(true); setError('');
    native<RemoteInfo[]>('repository_remotes', { handle }).then(values => { if (live) { setRemotes(values); if (values.length === 1) setRemote(values[0].name); } }).catch(e => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [handle, retry]);
  useEffect(() => {
    let live = true;
    void native<ProviderAccount[]>('list_provider_accounts').then(values => { if (live) setAccounts(values); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const selected = remotes.find(value => value.name === remote);
  const host = (() => { try { return new URL(selected?.pushUrl || selected?.fetchUrl || '').hostname.toLowerCase(); } catch { return ''; } })();
  const provider = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : host === 'dev.azure.com' ? 'azureDevops' : host === 'bitbucket.org' ? 'bitbucket' : null;
  const matchingAccounts = accounts.filter(account => account.provider === provider);
  const activeAccount = matchingAccounts.find(account => account.id === accountId) ?? (matchingAccounts.length === 1 ? matchingAccounts[0] : null);
  useEffect(() => {
    let live = true;
    setRequests([]);
    if (!remote || !activeAccount) return () => { live = false; };
    setLoadingRequests(true);
    void native<ProviderPullRequest[]>('provider_pull_requests', { handle, remote, accountId: activeAccount.id })
      .then(values => { if (live) setRequests(values); })
      .catch(e => { if (live) setError(errorMessage(e)); })
      .finally(() => { if (live) setLoadingRequests(false); });
    return () => { live = false; };
  }, [handle, remote, activeAccount?.id]);
  const localSource = source.startsWith('refs/heads/') && !!branch;
  let url = '', urlError = localSource ? '' : 'Choose a local branch as the pull-request source; tags and remote-tracking refs are unsupported.';
  if (localSource && selected && target) { try { url = pullRequestUrl(selected.pushUrl || selected.fetchUrl, branch, target); } catch (e) { urlError = errorMessage(e); } }
  async function openProvider() {
    if (!url || target === branch || opening.current || loading) return;
    opening.current = true; setPending(true); setError('');
    try { await native('open_external_url', { url }); if (alive.current) onClose(); }
    catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { opening.current = false; if (alive.current) setPending(false); }
  }
  async function createRequest() {
    if (!activeAccount || !target || !requestTitle.trim() || opening.current || loading) return;
    opening.current = true; setPending(true); setError('');
    try {
      const created = await native<ProviderPullRequest>('provider_create_pull_request', {
        handle, remote, accountId: activeAccount.id,
        request: { source: branch, target, title: requestTitle.trim(), description },
      });
      if (alive.current) { setRequests(previous => [created, ...previous]); setRequestTitle(''); setDescription(''); }
    } catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { opening.current = false; if (alive.current) setPending(false); }
  }
  const close = () => { if (!opening.current) onClose(); };
  const canOpen = !!url && target !== branch && !pending && !loading;
  const openButton = <button className={activeAccount ? 'secondary-button' : 'primary-button'} disabled={!canOpen} onClick={() => void openProvider()}>Open provider form</button>;
  return <Dialog title="Create pull request" onClose={close} footer={<>
    <button className="secondary-button" disabled={pending} onClick={close}>Cancel</button>
    {openButton}
    {activeAccount && <button className="primary-button" disabled={!target || target === branch || !requestTitle.trim() || pending || loading} onClick={() => void createRequest()}>Create pull request</button>}
  </>}>
    <p className="muted">From <span className="badge" data-tone="accent">{branch}</span>. Create it with a connected account or open the provider’s draft form. The source branch is never pushed automatically.</p>
    {loading && <p className="muted" role="status">Reading repository remotes…</p>}
    {!loading && !remotes.length && <p className="alert" role="status">{error ? 'Repository remotes could not be read.' : 'No remotes are configured for this repository.'} <button className="text-button" onClick={() => setRetry(value => value + 1)}>Reload remotes</button></p>}
    <label className="field">Destination remote<select value={remote} onChange={e => { setRemote(e.target.value); setTarget(''); setAccountId(''); setError(''); }}><option value="">Choose remote…</option>{remotes.map(value => <option key={value.name} value={value.name}>{value.name} — {value.pushUrl || value.fetchUrl}</option>)}</select></label>
    {selected && <p className="muted small">{selected.branches.includes(branch) ? `A locally known ${remote}/${branch} exists. This does not establish that the latest local commits are published.` : `Source publication is unknown: ${remote}/${branch} is not known locally. Publish the source before submitting the request.`}{selected.currentUpstream && ` Current branch upstream: ${selected.currentUpstream}.`}</p>}
    <label className="field">Base branch<input list="pr-bases" value={target} onChange={e => setTarget(e.target.value)} placeholder="Choose the intended base" /><datalist id="pr-bases">{selected?.branches.filter(value => value !== branch).map(value => <option key={value} value={value} />)}</datalist></label>
    {matchingAccounts.length > 1 && <label className="field">Provider account<select value={accountId} onChange={e => setAccountId(e.target.value)}><option value="">Choose account…</option>{matchingAccounts.map(account => <option key={account.id} value={account.id}>{account.username}</option>)}</select></label>}
    {activeAccount && <>
      <label className="field">Title<input value={requestTitle} maxLength={256} onChange={e => setRequestTitle(e.target.value)} /></label>
      <label className="field">Description<textarea value={description} maxLength={65536} onChange={e => setDescription(e.target.value)} /></label>
      <h3 className="section-label">Open pull requests {!loadingRequests && <span className="count">{requests.length}</span>}</h3>
      {loadingRequests ? <p className="muted" role="status">Loading pull requests…</p> : requests.length ? <ul className="plain-list">{requests.map(request => <li key={request.id}><button type="button" className="text-button" onClick={() => void native('open_external_url', { url: request.url }).catch(e => setError(errorMessage(e)))}>{request.title}</button><span className="muted small">{request.source} → {request.target}</span></li>)}</ul> : <p className="muted">No open pull requests found.</p>}
    </>}
    {(error || (!activeAccount && urlError)) && <p className="alert" role="alert">{error || urlError}</p>}
    {url && <p className="operation-url"><code>{url}</code></p>}
  </Dialog>;
}
