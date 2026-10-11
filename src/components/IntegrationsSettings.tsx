import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { ArrowUpRight, Check, ChevronRight, KeyRound, LockKeyhole, Monitor, ShieldCheck } from 'lucide-react';
import { errorMessage, native } from '../model/native';
import type { ProviderAccount as Account } from '../model/providerRepositories';
import githubIcon from '../assets/providers/github.svg';
import gitlabIcon from '../assets/providers/gitlab.svg';
import azureDevopsIcon from '../assets/providers/azure-devops.svg';
import bitbucketIcon from '../assets/providers/bitbucket.svg';

type Provider = Account['provider'];
interface DeviceAuthorization { id: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
const providers: Record<Provider, string> = {
  github: 'GitHub', gitlab: 'GitLab', azureDevops: 'Azure DevOps', bitbucket: 'Bitbucket Cloud',
};
const providerInfo = {
  github: { host: 'github.com', icon: githubIcon, description: 'Repositories & pull requests' },
  gitlab: { host: 'gitlab.com', icon: gitlabIcon, description: 'Repositories & merge requests' },
  azureDevops: { host: 'dev.azure.com', icon: azureDevopsIcon, description: 'Repositories & pull requests' },
  bitbucket: { host: 'bitbucket.org', icon: bitbucketIcon, description: 'Pull requests · API token' },
};

function ProviderIcon({ provider }: { provider: Provider }) {
  return <span className="integration-provider-icon" aria-hidden="true"><span className="integration-provider-mark" style={{ maskImage: `url("${providerInfo[provider].icon}")` }} /></span>;
}

export function IntegrationsSettings() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [provider, setProvider] = useState<Provider>('github');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceAuthorization | null>(null);
  const desktop = isTauri();
  const [loading, setLoading] = useState(desktop);
  const [refresh, setRefresh] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [operation, setOperation] = useState<'browser' | 'token' | 'disconnect' | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    setLoading(true); setLoadError('');
    void native<Account[]>('list_provider_accounts').then(value => { if (active) setAccounts(value); })
      .catch(e => { if (active) setLoadError(errorMessage(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [desktop, refresh]);
  useEffect(() => {
    if (!device) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const expires = Date.now() + device.expiresIn * 1000;
    async function poll() {
      try {
        if (Date.now() >= expires) throw new Error('Sign-in expired. Please try again.');
        const result = await native<{ account: Account | null; interval: number }>('provider_oauth_poll', { id: device!.id });
        if (!active) return;
        if (result.account) {
          setAccounts(previous => [...previous, result.account!]);
          setDevice(null); setBusy(false); setError('');
        } else {
          timer = setTimeout(() => void poll(), result.interval * 1000);
        }
      } catch (e) {
        if (active) { setError(errorMessage(e)); setDevice(null); setBusy(false); }
      }
    }
    timer = setTimeout(() => void poll(), device.interval * 1000);
    return () => {
      active = false;
      clearTimeout(timer);
      void native('provider_oauth_cancel', { id: device.id }).catch(() => {});
    };
  }, [device]);
  async function signIn() {
    if (busy) return;
    setBusy(true); setOperation('browser'); setError('');
    try {
      const authorization = await native<DeviceAuthorization>('provider_oauth_start', { provider });
      if (!mounted.current) {
        await native('provider_oauth_cancel', { id: authorization.id });
        return;
      }
      setDevice(authorization);
      await native('open_external_url', { url: authorization.verificationUri }).catch(e => {
        if (mounted.current) setError(errorMessage(e));
      });
    } catch (e) {
      if (mounted.current) { setError(errorMessage(e)); setBusy(false); }
    }
  }
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setOperation('token'); setError('');
    try {
      const account = await native<Account>('provider_connect_token', { provider, username: username.trim(), token });
      setAccounts(previous => [...previous, account]);
      setToken(''); setUsername('');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function disconnect(id: string) {
    if (busy) return;
    setBusy(true); setOperation('disconnect'); setError('');
    try {
      await native('provider_disconnect', { id });
      setAccounts(previous => previous.filter(account => account.id !== id));
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <section className="integrations-settings" aria-labelledby="integrations-heading">
    <header className="integrations-header"><h3 id="integrations-heading">Integrations</h3>
      <p>Your repositories, a little closer. Connect a hosting account to browse repositories and manage pull requests.</p>
    </header>
    <section className="integration-accounts" aria-labelledby="connected-accounts-heading">
      <div className="integration-section-heading"><h4 id="connected-accounts-heading">Connected accounts</h4><span>{accounts.length}</span></div>
      {loading ? <div className="integration-loading" role="status"><span /><span />Reading connected accounts…</div>
        : loadError ? <div className="settings-error" role="alert">{loadError} <button type="button" className="text-button" onClick={() => setRefresh(value => value + 1)}>Retry</button></div>
        : accounts.length ? <ul className="integration-account-list">{accounts.map(account => <li key={account.id}>
          <ProviderIcon provider={account.provider} /><div className="integration-account-identity"><strong>{account.username}</strong><small>{providers[account.provider]} · {account.oauth ? 'Browser sign-in' : 'Access token'}</small></div>
          <span className="integration-connected"><Check size={13} aria-hidden="true" />Connected</span>
          <button type="button" className="text-button" aria-label={`Disconnect ${providers[account.provider]} account ${account.username}`} disabled={busy} onClick={() => void disconnect(account.id)}>Disconnect</button>
        </li>)}</ul>
        : <div className="integration-empty"><LockKeyhole size={18} aria-hidden="true" /><div><strong>No accounts connected yet</strong><p>Choose a provider below to get started.</p></div></div>}
    </section>
    <section aria-labelledby="connect-provider-heading">
      <div className="integration-section-heading"><h4 id="connect-provider-heading">Connect a provider</h4></div>
      <div className="integration-provider-grid" role="group" aria-label="Hosting provider">
        {(Object.keys(providers) as Provider[]).map(id => <button type="button" key={id} className="integration-provider" aria-pressed={provider === id} disabled={busy || loading} onClick={() => { setProvider(id); setUsername(''); setToken(''); setError(''); }}>
          <ProviderIcon provider={id} /><span><strong>{providers[id]}</strong><small>{providerInfo[id].host}</small></span>
          {provider === id ? <Check className="integration-provider-selection" size={16} aria-hidden="true" /> : <ChevronRight className="integration-provider-selection" size={16} aria-hidden="true" />}
        </button>)}
      </div>
      <div className="integration-setup" aria-labelledby="provider-setup-heading">
        <div className="integration-setup-heading"><ProviderIcon provider={provider} /><div><h4 id="provider-setup-heading">Connect {providers[provider]}</h4><p>{providerInfo[provider].description}</p></div></div>
        {desktop ? <form onSubmit={event => void connect(event)}>
          {provider !== 'bitbucket' && !device && <div className="integration-browser-signin">
            <p>Sign in securely in your browser. Gitty never sees your password.</p>
            <button type="button" className="primary-button" disabled={busy || loading} onClick={() => void signIn()}>{busy && operation === 'browser' ? 'Starting sign-in…' : `Connect ${providers[provider]} in browser`}<ArrowUpRight size={15} aria-hidden="true" /></button>
          </div>}
          {provider === 'azureDevops' && <p className="integration-provider-help">Use a Microsoft work or school account for browser sign-in. For a personal Microsoft account, connect with an access token below.</p>}
          {provider === 'bitbucket' && <p className="integration-provider-help">Connect with a Bitbucket Cloud API token to manage pull requests. Repository browsing and account-based cloning are not available for this provider.</p>}
          {device && <div className="integration-device" role="status">
            <strong>Finish signing in with {providers[provider]}</strong><p>Enter this code in your browser, then approve Gitty.</p>
            <code className="integration-device-code">{device.userCode}</code>
            <small>Expires in {Math.ceil(device.expiresIn / 60)} minutes. Waiting for approval…</small>
            <div className="integration-device-actions"><a href={device.verificationUri} onClick={event => { event.preventDefault(); void native('open_external_url', { url: device.verificationUri }).catch(e => setError(errorMessage(e))); }}>Open sign-in page<ArrowUpRight size={14} aria-hidden="true" /></a>
              <button type="button" className="secondary-button" onClick={() => { setDevice(null); setBusy(false); setError(''); }}>Cancel sign-in</button></div>
          </div>}
          <details className="integration-token" key={provider} open={provider === 'bitbucket' || undefined}><summary><KeyRound size={15} aria-hidden="true" />{provider === 'bitbucket' ? 'Connect with an API token' : 'Connect with an access token instead'}</summary>
            <div className="integration-token-fields">
              <label className="settings-field">Account username<input value={username} maxLength={254} required disabled={busy || loading} autoComplete="username" onChange={event => setUsername(event.target.value)} /></label>
              <label className="settings-field">Access token<input value={token} type="password" required disabled={busy || loading} autoComplete="off" aria-describedby="integration-token-help" onChange={event => setToken(event.target.value)} /></label>
              <p id="integration-token-help">Use a token with repository read/write permissions.{provider === 'bitbucket' && ' Use an API token, not your account password.'}</p>
              <button type="submit" className="primary-button" disabled={busy || loading || !username.trim() || !token}>{busy && operation === 'token' ? 'Connecting…' : 'Connect account'}</button>
            </div>
          </details>
          {error && operation !== 'disconnect' && <p className="settings-error" role="alert">{error}</p>}
        </form> : <div className="integration-desktop-note"><Monitor size={18} aria-hidden="true" /><p>Provider connections are available in the desktop app.</p></div>}
      </div>
    </section>
    <footer className="integration-security"><ShieldCheck size={18} aria-hidden="true" /><div><strong>Credentials stay on your device</strong><p>Tokens are stored in your system credential store.</p>
      <details><summary>How Git authentication works</summary><p>Connected accounts authorize provider features and explicitly selected HTTPS clones. Fetch, pull, push and URL cloning use your Git credential helper or SSH agent. Gitty includes Git Credential Manager as an HTTPS fallback; WSL uses its own credentials.</p></details>
    </div></footer>
    {error && operation === 'disconnect' && <p className="settings-error" role="alert">{error}</p>}
  </section>;
}
