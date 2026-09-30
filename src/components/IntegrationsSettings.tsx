import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { errorMessage, native } from '../model/native';

type Provider = 'github' | 'gitlab' | 'azureDevops' | 'bitbucket';
interface Account { id: string; provider: Provider; username: string }
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
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void native<Account[]>('list_provider_accounts').then(value => { if (active) setAccounts(value); })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, []);
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
    <p>Connect an HTTPS Git host using an access token stored in your system credential store. Gitty uses the account for that provider’s remotes; SSH continues to use your SSH agent.</p>
    {accounts.map(account => <div className="commit-profile-row" key={account.id}><span><strong>{providers[account.provider]}</strong><small>{account.username}</small></span><button type="button" className="secondary-button" disabled={busy} onClick={() => void disconnect(account.id)}>Disconnect</button></div>)}
    {!accounts.length && <p>No provider accounts connected.</p>}
    {isTauri() ? <form onSubmit={event => void connect(event)}>
      <label className="settings-field">Provider<select value={provider} disabled={busy} onChange={event => setProvider(event.target.value as Provider)}>{Object.entries(providers).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className="settings-field">Account username<input value={username} maxLength={254} required disabled={busy} autoComplete="username" onChange={event => setUsername(event.target.value)} /></label>
      <label className="settings-field">Access token<input value={token} type="password" required disabled={busy} autoComplete="off" onChange={event => setToken(event.target.value)} /></label>
      <p>Use a token with repository read/write permissions. For Bitbucket Cloud, use an API token; account passwords cannot authenticate Git.</p>
      <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Connecting…' : 'Connect account'}</button>
    </form> : <p>Provider connections are available in the desktop app.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
