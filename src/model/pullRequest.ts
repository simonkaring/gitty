/** Provider links are constructed locally; opening one is a separate user action. */
export interface HostingRemote {
  provider: 'github' | 'gitlab' | 'azure';
  repositoryUrl: string;
}

export function parseHostingRemote(remote: string): HostingRemote {
  const value = remote.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
  let url: URL;
  try {
    url = new URL(!value.includes('://') && scp ? `ssh://${scp[1]}/${scp[2]}` : value);
  } catch { throw new Error('This remote is not a supported hosting URL. Choose a GitHub, GitLab, or Azure DevOps remote.'); }
  if (!['https:', 'ssh:'].includes(url.protocol) || url.password || (url.protocol === 'https:' && url.username) || url.search || url.hash || url.port) {
    throw new Error('Use a credential-free HTTPS or SSH hosting URL to create a pull request.');
  }
  const host = url.hostname.toLowerCase();
  let parts: string[];
  try { parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/').map(decodeURIComponent); }
  catch { throw new Error('The remote contains an invalid encoded repository path.'); }
  if (parts.some(part => !part || part === '.' || part === '..' || /[/\\\x00-\x1f\x7f]/.test(part))) throw new Error('The remote contains an invalid repository path.');
  const path = (items: string[]) => items.map(encodeURIComponent).join('/');
  if (host === 'github.com' && parts.length === 2) return { provider: 'github', repositoryUrl: `https://github.com/${path(parts)}` };
  if (host === 'gitlab.com' && parts.length >= 2) return { provider: 'gitlab', repositoryUrl: `https://gitlab.com/${path(parts)}` };
  if (host === 'ssh.dev.azure.com' && parts.length === 4 && parts[0] === 'v3') {
    const [, organization, project, repository] = parts;
    return { provider: 'azure', repositoryUrl: `https://dev.azure.com/${path([organization, project])}/_git/${encodeURIComponent(repository)}` };
  }
  if (host === 'dev.azure.com' && parts.length === 4 && parts[2] === '_git') return { provider: 'azure', repositoryUrl: `https://dev.azure.com/${path(parts)}` };
  if (/^[a-z0-9-]+\.visualstudio\.com$/.test(host) && [3, 4].includes(parts.length) && parts[parts.length - 2] === '_git') {
    return { provider: 'azure', repositoryUrl: `https://${host}/${path(parts)}` };
  }
  throw new Error('PR links currently support github.com, gitlab.com, and Azure DevOps. Open this hosting provider manually.');
}

function branchName(value: string): string {
  const name = value.replace(/^refs\/heads\//, '');
  if (!name || name === '@' || name.startsWith('-') || /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(name) || name.includes('..') || name.includes('@{') || name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Enter a valid source and base branch name.');
  }
  return name;
}

export function pullRequestUrl(remoteUrl: string, source: string, target: string): string {
  const remote = parseHostingRemote(remoteUrl);
  const from = branchName(source), to = branchName(target);
  if (from === to) throw new Error('Choose different source and base branches.');
  if (remote.provider === 'github') return `${remote.repositoryUrl}/compare/${encodeURIComponent(to)}...${encodeURIComponent(from)}?expand=1`;
  if (remote.provider === 'gitlab') {
    const query = new URLSearchParams({ 'merge_request[source_branch]': from, 'merge_request[target_branch]': to });
    return `${remote.repositoryUrl}/-/merge_requests/new?${query}`;
  }
  const query = new URLSearchParams({ sourceRef: from, targetRef: to });
  return `${remote.repositoryUrl}/pullrequestcreate?${query}`;
}
