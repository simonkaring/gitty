import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { errorMessage, native } from '../model/native';

type Provider = 'github' | 'gitlab' | 'azureDevops' | 'bitbucket';
interface Account { id: string; provider: Provider; username: string }
interface DeviceAuthorization { id: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
const providers: Record<Provider, string> = {
  github: 'GitHub', gitlab: 'GitLab', azureDevops: 'Azure DevOps', bitbucket: 'Bitbucket Cloud',
};

export function IntegrationsSettings() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [provider, setProvider] = useState<Provider>('github');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceAuthorization | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void native<Account[]>('list_provider_accounts').then(value => { if (active) setAccounts(value); })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, []);
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
    setBusy(true); setError('');
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
    setBusy(true); setError('');
    try {
      const account = await native<Account>('provider_connect_token', { provider, username: username.trim(), token });
      setAccounts(previous => [...previous, account]);
      setToken(''); setUsername('');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function disconnect(id: string) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await native('provider_disconnect', { id });
      setAccounts(previous => previous.filter(account => account.id !== id));
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="integrations-heading"><h3 id="integrations-heading">Provider accounts</h3>
    <p>Clone, fetch, pull and push use your Git credential helper or SSH agent. Gitty includes Git Credential Manager for HTTPS sign-in when existing helpers cannot supply credentials.</p>
    <p>Connect a provider account for pull requests and provider features. Credentials are stored in your system credential store.</p>
    {accounts.map(account => <div className="commit-profile-row" key={account.id}><span><strong>{providers[account.provider]}</strong><small>{account.username}</small></span><button type="button" className="secondary-button" disabled={busy} onClick={() => void disconnect(account.id)}>Disconnect</button></div>)}
    {!accounts.length && <p>No provider accounts connected.</p>}
    {isTauri() ? <form onSubmit={event => void connect(event)}>
      <label className="settings-field">Provider<select value={provider} disabled={busy} onChange={event => setProvider(event.target.value as Provider)}>{Object.entries(providers).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      {provider !== 'bitbucket' && <button type="button" className="primary-button" disabled={busy} onClick={() => void signIn()}>{busy ? 'Waiting for sign-in…' : `Connect ${providers[provider]} in browser`}</button>}
      {provider === 'azureDevops' && <p>Browser sign-in uses a Microsoft work or school account. Personal Microsoft accounts can use an access token for provider features.</p>}
      {device && <div role="status">
        <p>Enter <strong>{device.userCode}</strong> in your browser, then approve Gitty. This code expires in {Math.ceil(device.expiresIn / 60)} minutes.</p>
        <p><a href={device.verificationUri} onClick={event => { event.preventDefault(); void native('open_external_url', { url: device.verificationUri }).catch(e => setError(errorMessage(e))); }}>Open sign-in page</a></p>
        <button type="button" className="secondary-button" onClick={() => { setDevice(null); setBusy(false); setError(''); }}>Cancel sign-in</button>
      </div>}
      <details open={provider === 'bitbucket' || undefined}><summary>Connect with an access token instead</summary>
      <label className="settings-field">Account username<input value={username} maxLength={254} required disabled={busy} autoComplete="username" onChange={event => setUsername(event.target.value)} /></label>
      <label className="settings-field">Access token<input value={token} type="password" required disabled={busy} autoComplete="off" onChange={event => setToken(event.target.value)} /></label>
      <p>Use a token with repository read/write permissions. For Bitbucket Cloud, use an API token; account passwords cannot authenticate Git.</p>
      <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Connecting…' : 'Connect account'}</button>
      </details>
    </form> : <p>Provider connections are available in the desktop app.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
