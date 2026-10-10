export type RepositoryProvider = 'github' | 'gitlab' | 'azureDevops';
export interface ProviderAccount { id: string; provider: RepositoryProvider | 'bitbucket'; username: string; oauth?: boolean }
export interface ProviderRepository { id: string; name: string; namespace: string; cloneUrl: string; private: boolean; project: string | null }
export interface ProviderRepositoryPage { repositories: ProviderRepository[]; nextCursor: string | null }
export const REPOSITORY_PROVIDER_LABELS: Record<RepositoryProvider, string> = { github: 'GitHub', gitlab: 'GitLab.com', azureDevops: 'Azure DevOps' };
