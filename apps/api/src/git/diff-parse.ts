import type { FileDiff, FileStatus } from '@pcbhub/shared';

const STATUS: Record<string, FileStatus> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  C: 'copied',
  T: 'type_changed',
};

const ZERO = /^0+$/;

/** Parse `git diff --raw -z --abbrev=40` output. */
export function parseRaw(out: string): Omit<FileDiff, 'additions' | 'deletions' | 'binary' | 'patch' | 'truncated'>[] {
  const parts = out.split('\0');
  const files: Omit<FileDiff, 'additions' | 'deletions' | 'binary' | 'patch' | 'truncated'>[] = [];
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i++];
    if (!meta || !meta.startsWith(':')) continue;
    const [, , oldOid, newOid, statusRaw] = meta.slice(1).split(' ');
    const code = (statusRaw ?? 'M')[0]!;
    const status = STATUS[code] ?? 'modified';
    let oldPath: string | null = null;
    let path: string;
    if (code === 'R' || code === 'C') {
      oldPath = parts[i++] ?? '';
      path = parts[i++] ?? '';
    } else {
      path = parts[i++] ?? '';
    }
    files.push({
      path,
      oldPath,
      status,
      oldOid: oldOid && !ZERO.test(oldOid) ? oldOid : null,
      newOid: newOid && !ZERO.test(newOid) ? newOid : null,
    });
  }
  return files;
}

/** Parse `git diff --numstat -z` output, keyed by new path. */
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const parts = out.split('\0');
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i++];
    if (!entry) continue;
    const [a, d, p] = entry.split('\t');
    let path = p ?? '';
    if (path === '') {
      // rename: "a\td\t\0old\0new"
      i++;
      path = parts[i++] ?? '';
    }
    const binary = a === '-' && d === '-';
    map.set(path, { additions: binary ? 0 : Number(a), deletions: binary ? 0 : Number(d), binary });
  }
  return map;
}

/** Split a full `git diff` patch into per-file chunks in output order. */
export function splitPatch(patch: string): string[] {
  if (!patch) return [];
  const out: string[] = [];
  const re = /^diff --git /gm;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch))) starts.push(m.index);
  for (let k = 0; k < starts.length; k++) out.push(patch.slice(starts[k], starts[k + 1] ?? patch.length));
  return out;
}

/** Remove the `diff --git`/index/---/+++ header, keeping only hunks. */
export function hunksOnly(filePatch: string): string {
  const idx = filePatch.search(/^@@ /m);
  return idx === -1 ? '' : filePatch.slice(idx);
}
