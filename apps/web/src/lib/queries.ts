import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import type {
  CheckRunInfo,
  CommitInfo,
  CurrentUser,
  RefInfo,
  RepoInfo,
} from '@pcbhub/shared';
import { api, repoPath } from './api';

export const keys = {
  me: ['me'] as const,
  repo: (owner: string, repo: string) => ['repo', owner.toLowerCase(), repo.toLowerCase()] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => api.get<CurrentUser | null>('/auth/me'), staleTime: 60_000 });
}

export function useRepo(owner: string, repo: string) {
  return useQuery({ queryKey: [...keys.repo(owner, repo), 'info'], queryFn: () => api.get<RepoInfo>(repoPath(owner, repo)) });
}

export function useBranches(owner: string, repo: string, opts: Partial<UseQueryOptions<RefInfo[]>> = {}) {
  return useQuery({ queryKey: [...keys.repo(owner, repo), 'branches'], queryFn: () => api.get<RefInfo[]>(repoPath(owner, repo, '/branches')), ...opts });
}

export function useChecks(owner: string, repo: string, sha: string | undefined | null) {
  return useQuery({
    queryKey: [...keys.repo(owner, repo), 'checks', sha],
    queryFn: () => api.get<{ sha: string; runs: CheckRunInfo[] }>(repoPath(owner, repo, '/checks'), { sha: sha ?? undefined }),
    enabled: Boolean(sha),
  });
}

export function useCommits(owner: string, repo: string, ref: string, path = '', page = 1) {
  return useQuery({
    queryKey: [...keys.repo(owner, repo), 'commits', ref, path, page],
    queryFn: () => api.get<{ commits: CommitInfo[]; hasMore: boolean }>(repoPath(owner, repo, '/commits'), { ref, path, page }),
  });
}
