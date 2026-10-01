import type { GitRef } from '../model/types';
import type { GraphCommit } from './layout';

const PALETTE_SIZE = 8;
const trunk = (name: string) => name === 'main' || name === 'master';
const compare = (a: string, b: string) => Number(trunk(b)) - Number(trunk(a)) || (a < b ? -1 : a > b ? 1 : 0);

export function branchName(ref: GitRef): string | null {
  if (ref.kind === 'tag' || (ref.kind === 'remote' && ref.name.endsWith('/HEAD'))) return null;
  return ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name;
}

function hashIndex(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return (hash >>> 0) % PALETTE_SIZE;
}

export function assignBranchColors(commits: readonly GraphCommit[], refs: readonly GitRef[], workingId?: string) {
  const names = [...new Set(refs.map(branchName).filter((name): name is string => name !== null))].sort(compare);
  const branches = new Map<string, number>();
  for (const name of names) {
    let index = hashIndex(name);
    // ponytail: eight theme colors; reuse after eight branches. Expand the palette if more hues are needed.
    if (branches.size < PALETTE_SIZE) while ([...branches.values()].includes(index)) index = (index + 1) % PALETTE_SIZE;
    branches.set(name, index);
  }
  type Owner = { name: string; named: boolean };
  const owners = new Map<string, Owner>();
  const tips = new Map<string, string>();
  for (const ref of refs) {
    const name = branchName(ref), prior = tips.get(ref.commitId);
    if (name !== null && (prior === undefined || compare(name, prior) < 0)) tips.set(ref.commitId, name);
  }
  const better = (a: Owner, b: Owner) => Number(trunk(b.name) && b.named) - Number(trunk(a.name) && a.named)
    || Number(b.named) - Number(a.named) || compare(a.name, b.name);
  const rows = new Uint8Array(commits.length);
  commits.forEach((commit, row) => {
    if (commit.id === workingId) return;
    const inherited = owners.get(commit.id), name = tips.get(commit.id);
    const own = name === undefined ? undefined : { name, named: true };
    // An own ref wins over an inherited ordinary branch; trunk always wins.
    const owner = own && (!inherited || !(inherited.named && trunk(inherited.name)) || (trunk(own.name) && compare(own.name, inherited.name) <= 0))
      ? own : inherited ?? { name: commit.id, named: false };
    rows[row] = owner.named ? branches.get(owner.name)! : hashIndex(owner.name);
    const parent = commit.parents[0], prior = owners.get(parent);
    if (parent && (!prior || better(owner, prior) < 0)) owners.set(parent, owner);
  });
  const workingRow = commits.findIndex(commit => commit.id === workingId);
  if (workingRow >= 0) {
    const parentRow = commits.findIndex(commit => commit.id === commits[workingRow].parents[0]);
    if (parentRow >= 0) rows[workingRow] = rows[parentRow];
  }
  return { rows, branches };
}
