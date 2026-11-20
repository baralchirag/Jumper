import type { CheckConclusion, CheckName, CheckStatus } from './constants';

export interface AnalyzeCommitJob {
  repoId: string;
  sha: string;
  ref?: string;
}

export type PlatformEvent =
  | {
      type: 'check';
      repoId: string;
      sha: string;
      name: CheckName;
      projectPath: string;
      status: CheckStatus;
      conclusion: CheckConclusion | null;
    }
  | { type: 'push'; repoId: string; ref: string; before: string | null; after: string | null };

export function repoTopic(repoId: string): string {
  return `repo:${repoId}`;
}
