import { useEffect, useRef, useState } from 'react';
import type { RemoteInfo } from '../model/operations';
import { native, errorMessage } from '../model/native';
import { pullRequestUrl } from '../model/pullRequest';

export function PullRequestDialog({ handle, source, onClose }: { handle: string; source: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [remote, setRemote] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const opening = useRef(false);
  const alive = useRef(true);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const branch = source.replace(/^refs\/heads\//, '');
  useEffect(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; }; }, []);
  useEffect(() => { let live = true; setLoading(true); setError('');
    native<RemoteInfo[]>('repository_remotes', { handle }).then(values => { if (live) { setRemotes(values); if (values.length === 1) setRemote(values[0].name); } }).catch(e => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [handle, retry]);
  const selected = remotes.find(value => value.name === remote);
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
  return <dialog ref={dialog} className="dialog operation-dialog" aria-label="Create pull request" onCancel={event => { if (opening.current) event.preventDefault(); else onClose(); }}><h2>Create pull request</h2><p>Source: <strong>{branch}</strong></p><p>Opens your provider’s draft form. Locally known remote-tracking references are used; background fetch may update them, but the source branch is never pushed automatically.</p>
    {loading && <p role="status">Reading repository remotes…</p>}
    {!loading && !remotes.length && <p role="status">{error ? 'Repository remotes could not be read.' : 'No remotes are configured for this repository.'} <button onClick={() => setRetry(value => value + 1)}>Reload remotes</button></p>}
    <label>Destination remote<select value={remote} onChange={e => { setRemote(e.target.value); setTarget(''); }}><option value="">Choose remote…</option>{remotes.map(value => <option key={value.name} value={value.name}>{value.name} — {value.pushUrl || value.fetchUrl}</option>)}</select></label>
    {selected && <p>{selected.branches.includes(branch) ? `A locally known ${remote}/${branch} exists. This does not establish that the latest local commits are published.` : `Source publication is unknown: ${remote}/${branch} is not known locally. Publish the source before submitting the request.`}{selected.currentUpstream && ` Current branch upstream: ${selected.currentUpstream}.`}</p>}
    <label>Base branch<input list="pr-bases" value={target} onChange={e => setTarget(e.target.value)} placeholder="Choose the intended base" /><datalist id="pr-bases">{selected?.branches.filter(value => value !== branch).map(value => <option key={value} value={value} />)}</datalist></label>
    {(error || urlError) && <p role="alert">{error || urlError}</p>}{url && <p className="operation-url">{url}</p>}
    <button className="primary-button" disabled={!url || target === branch || pending || loading} onClick={() => void openProvider()}>Open provider form</button><button disabled={pending} onClick={onClose}>Cancel</button>
  </dialog>;
}
