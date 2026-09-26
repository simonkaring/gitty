import type { RepositorySession } from './repository';

export interface CommitProfile { id: string; name: string; email: string }
export const MAX_COMMIT_PROFILES = 20;

export function validateCommitProfile(value: unknown): CommitProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid commit profile.');
  const profile = value as CommitProfile;
  if (Object.keys(profile).some(key => !['id', 'name', 'email'].includes(key)) ||
    typeof profile.id !== 'string' || !/^profile-[a-zA-Z0-9-]{1,80}$/.test(profile.id) ||
    typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 120 || /[<>\x00-\x1f\x7f]/.test(profile.name) ||
    typeof profile.email !== 'string' || !profile.email.trim() || profile.email.length > 254 || /[<>\s\x00-\x1f\x7f]/.test(profile.email) || !/^[^@]+@[^@]+$/.test(profile.email)) {
    throw new Error('Enter a valid name and email for the commit profile.');
  }
  return { id: profile.id, name: profile.name.trim(), email: profile.email.trim() };
}

export function commitProfileRepositoryKey(session: RepositorySession): string {
  return JSON.stringify([session.location.kind, session.location.kind === 'wsl' ? session.location.distribution : '', session.root]);
}
