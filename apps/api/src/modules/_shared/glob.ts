/**
 * Path glob used by approval rules and part policies. Matching is done without regular expressions so a
 * hostile pattern cannot cause catastrophic backtracking.
 *   `*`  any run of characters except `/`
 *   `**` any number of whole path segments (including none)
 *   `?`  one character except `/`
 * A pattern with no `/` matches the file name in any folder (like .gitignore). Case-insensitive.
 */
function matchSegment(pattern: string, text: string): boolean {
  // Iterative wildcard matcher: O(len(pattern) * len(text)) worst case, no recursion.
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

export function matchesGlob(pattern: string, path: string): boolean {
  const pat = pattern.toLowerCase().replace(/^\/+/, '');
  const target = path.toLowerCase().replace(/^\/+/, '');
  const pSegs = (pat.includes('/') ? pat : `**/${pat}`).split('/');
  const tSegs = target.split('/');
  // memo: does pSegs[i..] match tSegs[j..]?
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (tSegs.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === pSegs.length) r = j === tSegs.length;
    else if (pSegs[i] === '**') r = go(i + 1, j) || (j < tSegs.length && go(i, j + 1));
    else r = j < tSegs.length && matchSegment(pSegs[i]!, tSegs[j]!) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}
