export interface ChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
  before: string[];
  after: string[];
}

export interface Commit {
  id: string;
  parents: string[];
  subject: string;
  body: string;
  author: string;
  email: string;
  timestamp: number;
  branch: string;
  files: ChangedFile[];
}

export interface GitRef {
  name: string;
  commitId: string;
  kind: 'local' | 'remote' | 'tag';
}

export interface RepositorySnapshot {
  commits: Commit[];
  refs: GitRef[];
  head: string;
}

/** Boundary for future native Git and WSL transports. All IDs are opaque. */
export interface HistoryProvider {
  readonly kind: 'demo' | 'native' | 'wsl';
  snapshot(repository: string): Promise<RepositorySnapshot>;
}
