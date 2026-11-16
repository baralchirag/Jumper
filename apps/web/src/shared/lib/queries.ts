import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import type {
  CheckRunInfo,
  CommitInfo,
  CurrentUser,
  RefInfo,
  RepoInfo,
} from '@jumper/shared';
import { api, repoPath } from './api';

export const keys = {
  me: ['me'] as const,
  repo: (owner: string, repo: string) => ['repo', owner.toLowerCase(), repo.toLowerCase()] as const,
};

const SIGNED_IN = 'jumper-signed-in';

/** Whether this browser was signed in last time; lets the home page pick landing vs workbench before /auth/me answers. */
export function wasSignedIn() {
  try {
    return localStorage.getItem(SIGNED_IN) === '1';
  } catch {
    return false;
  }
}

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      const me = await api.get<CurrentUser | null>('/auth/me');
      try {
        if (me) localStorage.setItem(SIGNED_IN, '1');
        else localStorage.removeItem(SIGNED_IN);
      } catch {
        /* storage unavailable: the hint is only an optimisation */
      }
      return me;
    },
    staleTime: 60_000,
  });
}

export interface Providers {
  github: boolean;
  signup: boolean;
  /** The instance blocks writes until an account confirms its email address. */
  emailVerification: boolean;
  /** Instance-wide single sign-on buttons (Google, Microsoft, connections an administrator added). */
  sso?: import('@jumper/shared').SsoProvider[];
}

export function useProviders() {
  return useQuery({ queryKey: ['providers'], queryFn: () => api.get<Providers>('/auth/providers'), staleTime: Infinity });
}

export function useRepo(owner: string, repo: string, opts: { refetchInterval?: number | false } = {}) {
  return useQuery({ queryKey: [...keys.repo(owner, repo), 'info'], queryFn: () => api.get<RepoInfo>(repoPath(owner, repo)), ...opts });
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
