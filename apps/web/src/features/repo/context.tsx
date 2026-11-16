import { createContext, useContext } from 'react';
import type { RepoInfo } from '@jumper/shared';

export const RepoContext = createContext<RepoInfo | null>(null);

export function useRepoInfo(): RepoInfo {
  const r = useContext(RepoContext);
  if (!r) throw new Error('useRepoInfo outside RepoLayout');
  return r;
}

export function canWrite(r: RepoInfo): boolean {
  return r.permission === 'write' || r.permission === 'admin';
}
