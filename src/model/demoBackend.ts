import { createDemoHistory } from './demo';
import { demoCommittedFiles, demoFileDiff, demoStatus, demoWorkingFiles, type DemoFile } from './demoWorkflow';
import { diffLines } from './diff';
import { statusGroups } from './native';
import type { CommitDetail, DiffFile, DiffSpec, FileDiff, RepositoryLocation, RepositoryState } from './repository';
import type { ChangedFile, Commit } from './types';

/** In-memory stand-in for the Tauri backend so the demo runs through the real
 * workspace UI. Supports reads plus stage/unstage/commit; every other write
 * rejects with a clear message. Handles are prefixed `demo:` so calls can be
 * routed by handle even after the workspace switches modes. */
export const DEMO_REPOS = [
  { name: 'gitty', seed: 1 },
  { name: 'orbit-design', seed: 7 },
  { name: 'little-api', seed: 13 },
];
export const demoLocation = (name: string): RepositoryLocation => ({ kind: 'native', path: `~/Developer/${name}` });

interface DemoRepo { name: string; commits: Commit[]; refs: { name: string; commitId: string; kind: 'local' | 'remote' | 'tag' }[]; head: string; files: DemoFile[]; ahead: number }
const repos = new Map<string, DemoRepo>();

function repo(handle: unknown): DemoRepo {
  const found = typeof handle === 'string' ? repos.get(handle) : undefined;
  if (!found) throw { code: 'not_found', message: 'Demo repository session expired. Reopen it.' };
  return found;
}
function load(name: string): DemoRepo {
  const handle = `demo:${name}`;
  if (!repos.has(handle)) {
    const seed = DEMO_REPOS.find(item => item.name === name)?.seed ?? 1;
    const snapshot = createDemoHistory(seed);
    repos.set(handle, { name, commits: snapshot.commits, refs: snapshot.refs, head: snapshot.head, files: demoWorkingFiles(), ahead: 0 });
  }
  return repos.get(handle)!;
}
const seconds = (commit: Commit) => ({ id: commit.id, parents: commit.parents, subject: commit.subject, author: commit.author, email: commit.email, timestamp: Math.floor(commit.timestamp / 1000) });
function state(r: DemoRepo): RepositoryState {
  const root = demoLocation(r.name).path;
  return {
    session: { handle: `demo:${r.name}`, location: demoLocation(r.name), name: r.name, root, gitDir: `${root}/.git`, commonDir: `${root}/.git`, linkedWorktree: false, shallow: false, bare: false, head: r.head, headRef: 'refs/heads/main' },
    refs: r.refs.map(ref => ({ ...ref, fullName: ref.kind === 'local' ? `refs/heads/${ref.name}` : ref.kind === 'remote' ? `refs/remotes/${ref.name}` : `refs/tags/${ref.name}` })),
    remotes: ['origin'], fingerprint: r.head,
  };
}
const statusCode = (file: ChangedFile) => file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M';
function commitFiles(r: DemoRepo, spec: DiffSpec): ChangedFile[] {
  const oid = spec.kind === 'commit' ? spec.oid : spec.kind === 'compare' ? spec.target : '';
  return r.commits.find(commit => commit.id === oid)?.files ?? [];
}

const unsupported = (what: string) => { throw { code: 'unsupported', message: `Not available in the demo: ${what}. The demo simulates staging and committing only.` }; };

export async function demoInvoke(command: string, args: Record<string, unknown>): Promise<unknown> {
  const r = () => repo(args.handle);
  switch (command) {
    case 'app_start_dragging': case 'repository_close': return;
    case 'repository_recent': return DEMO_REPOS.map(item => demoLocation(item.name));
    case 'wsl_distributions': case 'repository_stashes': case 'list_provider_accounts': return [];
    case 'repository_open': {
      const location = args.location as RepositoryLocation;
      const match = DEMO_REPOS.find(item => demoLocation(item.name).path === location.path);
      if (!match) throw { code: 'not_found', message: 'The demo only includes its sample repositories.' };
      return state(load(match.name));
    }
    case 'repository_state': return state(r());
    case 'repository_operation_state': return { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'none' };
    case 'repository_branch_relation': return [1, 0];
    case 'repository_status': return demoStatus(r().files, r().head);
    case 'repository_history': {
      const { commits, head } = r();
      const offset = typeof args.cursor === 'string' ? Number(args.cursor.split(':')[1]) : 0;
      const end = Math.min(offset + Number(args.limit ?? 200), commits.length);
      return { commits: commits.slice(offset, end).map(seconds), cursor: end < commits.length ? `${head}:${end}` : null, generation: head, shallow: false };
    }
    case 'repository_commit': {
      const commit = r().commits.find(item => item.id === args.oid);
      if (!commit) throw { code: 'not_found', message: 'Commit not found in the demo history.' };
      return { ...seconds(commit), body: commit.body } satisfies CommitDetail;
    }
    case 'repository_diff_files': {
      const spec = args.spec as DiffSpec;
      if (spec.kind === 'commit' || spec.kind === 'compare') return commitFiles(r(), spec).map(file => ({ path: file.path, oldPath: null, status: statusCode(file), additions: file.additions, deletions: file.deletions, binary: false }) satisfies DiffFile);
      return statusGroups(demoStatus(r().files, r().head).entries)[spec.kind].map(entry => ({ path: entry.path, oldPath: null, status: spec.kind === 'staged' ? entry.indexStatus : spec.kind === 'untracked' ? 'A' : entry.worktreeStatus, additions: null, deletions: null, binary: false }));
    }
    case 'repository_diff': {
      const spec = args.spec as DiffSpec;
      if (spec.kind !== 'commit' && spec.kind !== 'compare') return demoFileDiff(r().files, spec, String(args.path));
      const file = commitFiles(r(), spec).find(item => item.path === args.path);
      if (!file) throw { code: 'not_found', message: 'File not found in this demo commit.' };
      return { path: file.path, binary: false, truncated: false, message: null, hunks: [{ header: `@@ -1,${file.before.length} +1,${file.after.length} @@`, lines: diffLines(file.before, file.after).map(line => ({ kind: line.kind, content: line.text, oldLine: line.oldLine ?? null, newLine: line.newLine ?? null })) }] } satisfies FileDiff;
    }
    case 'repository_search': {
      const text = String((args.query as { text?: string }).text ?? '').toLowerCase();
      return { commits: r().commits.filter(commit => `${commit.subject} ${commit.author} ${commit.id}`.toLowerCase().includes(text)).slice(0, 500).map(seconds), truncated: false };
    }
    case 'repository_sync_info': return { branch: 'main', upstream: 'origin/main', ahead: r().ahead, behind: 0, remotes: ['origin'] };
    case 'repository_remotes': return [{ name: 'origin', fetchUrl: `https://example.com/${r().name}.git`, pushUrl: `https://example.com/${r().name}.git`, branches: ['main', 'feature/command-palette'], currentUpstream: 'main' }];
    case 'repository_git_identity': return { local: { name: null, email: null }, effective: { name: 'Demo User', email: 'demo@example.com' } };
    case 'repository_stage': case 'repository_unstage': {
      for (const file of r().files) if ((args.paths as string[]).includes(file.path)) file.index = command === 'repository_stage' ? file.working : file.head;
      return;
    }
    case 'repository_create_commit': {
      const current = r();
      const files = demoCommittedFiles(current.files);
      if (!files.length) throw { code: 'nothing_staged', message: 'Stage at least one change before committing.' };
      const [subject, ...rest] = String(args.message).split('\n');
      const id = Array.from(crypto.getRandomValues(new Uint8Array(20)), byte => byte.toString(16).padStart(2, '0')).join('');
      current.commits.unshift({ id, parents: [current.head], subject, body: rest.join('\n').trim(), author: 'Demo User', email: 'demo@example.com', timestamp: Date.now(), branch: 'main', files });
      current.refs = current.refs.map(ref => ref.name === 'main' ? { ...ref, commitId: id } : ref);
      current.head = id; current.ahead++;
      current.files = current.files.filter(file => file.index !== null || file.working !== null).map(file => ({ ...file, head: file.index }));
      return { oid: id };
    }
    case 'repository_pick': case 'repository_pick_clone_parent': return unsupported('opening folders');
    case 'repository_clone': return unsupported('cloning');
    case 'repository_stage_hunk': case 'repository_unstage_hunk': return unsupported('hunk staging');
    case 'repository_amend_commit': return unsupported('amending');
    case 'repository_remote_action': {
      const kind = (args.action as { kind: string }).kind;
      if (kind === 'fetch' || kind === 'backgroundFetch') return { output: kind === 'fetch' ? 'Already up to date (demo remote).' : '' };
      return unsupported('pull and push');
    }
    default: return unsupported('this action');
  }
}
