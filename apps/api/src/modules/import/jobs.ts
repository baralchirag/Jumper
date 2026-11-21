/**
 * Imports that outlive their request. A large repository can take minutes to copy, so the request waits only a few
 * seconds and the copy carries on here; the repository page shows progress (or the reason it stopped) from this
 * table. It is per process and in memory: after a restart a stopped import leaves an empty repository, which the
 * owner can push to or delete.
 */
interface Job {
  source: string;
  startedAt: Date;
  error?: string;
  /** When a failure was recorded; failures are forgotten after a day. */
  failedAt?: number;
}

const jobs = new Map<string, Job>();
const DAY = 24 * 60 * 60 * 1000;

export function startImport(repoId: string, source: string): void {
  jobs.set(repoId, { source, startedAt: new Date() });
}

export function finishImport(repoId: string): void {
  jobs.delete(repoId);
}

export function failImport(repoId: string, message: string): void {
  const j = jobs.get(repoId);
  if (j) jobs.set(repoId, { ...j, error: message, failedAt: Date.now() });
}

/** Fields for RepoInfo: `importing` while copying, `importError` after a background failure. */
export function importState(repoId: string): { importing?: { source: string; startedAt: string }; importError?: { source: string; message: string } } {
  const j = jobs.get(repoId);
  if (!j) return {};
  if (j.error !== undefined) {
    if (Date.now() - (j.failedAt ?? 0) > DAY) {
      jobs.delete(repoId);
      return {};
    }
    return { importError: { source: j.source, message: j.error } };
  }
  return { importing: { source: j.source, startedAt: j.startedAt.toISOString() } };
}
