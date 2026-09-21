import { describe, expect, it } from 'vitest';
import { parseHostingRemote, pullRequestUrl } from './pullRequest';

describe('user-triggered provider links', () => {
  it('preserves source/base direction and encodes branch URL characters', () => {
    expect(pullRequestUrl('git@github.com:team/project.git', 'feature/a#b', 'refs/heads/main')).toBe('https://github.com/team/project/compare/main...feature%2Fa%23b?expand=1');
    expect(parseHostingRemote('ssh://git@github.com/team/project.git').repositoryUrl).toBe('https://github.com/team/project');
  });
  it('preserves nested GitLab namespaces and branch query values', () => {
    const url = new URL(pullRequestUrl('https://gitlab.com/team/subgroup/project.git', 'feature/a&b', 'release/v2'));
    expect(url.pathname).toBe('/team/subgroup/project/-/merge_requests/new');
    expect(url.searchParams.get('merge_request[source_branch]')).toBe('feature/a&b');
    expect(url.searchParams.get('merge_request[target_branch]')).toBe('release/v2');
  });
  it('supports Azure HTTPS, SSH and legacy organization URLs', () => {
    const expected = 'https://dev.azure.com/org/My%20Project/_git/repo/pullrequestcreate?sourceRef=feature%2Fa&targetRef=main';
    expect(pullRequestUrl('https://dev.azure.com/org/My%20Project/_git/repo', 'feature/a', 'main')).toBe(expected);
    expect(pullRequestUrl('git@ssh.dev.azure.com:v3/org/My%20Project/repo', 'feature/a', 'main')).toBe(expected);
    expect(parseHostingRemote('https://org.visualstudio.com/DefaultCollection/project/_git/repo').provider).toBe('azure');
  });
  it('rejects ambiguous providers, credentials, URL suffixes and invalid refs', () => {
    for (const remote of ['https://github.com.evil.test/a/b', 'https://token@github.com/a/b', 'ssh://git:secret@github.com/a/b', 'file:///repo', 'https://github.com/a/b?query=1', 'https://github.com/a%2fb/c', '/local/repo']) expect(() => pullRequestUrl(remote, 'feature', 'main')).toThrow();
    for (const name of ['', '../main', '-main', 'a b', 'a..b', 'a\\b', 'refs/heads/main']) expect(() => pullRequestUrl('https://github.com/a/b', name, 'main')).toThrow();
  });
});
