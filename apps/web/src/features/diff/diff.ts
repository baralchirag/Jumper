export type DiffLineType = 'context' | 'add' | 'del' | 'hunk';

export interface DiffLine {
  type: DiffLineType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

/** Parse unified-diff hunks (as returned by the API) into display lines. */
export function parseHunks(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      out.push({ type: 'hunk', oldNo: null, newNo: null, text: raw });
    } else if (raw.startsWith('+')) {
      out.push({ type: 'add', oldNo: null, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      out.push({ type: 'del', oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    } else if (raw.startsWith(' ')) {
      out.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
    }
  }
  return out;
}
