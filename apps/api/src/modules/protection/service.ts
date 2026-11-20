import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, branchProtection, eq, namespaces, repositories, type BranchProtection } from '@jumper/db';
import { effectivePolicy } from '../policy/service';
import { holdOnRepo } from '../legal/holds';
import type { Ctx } from '../../context';

/** Characters allowed in a protection pattern. No brackets or braces: patterns reach a shell `case`, so keep them boring. */
export const PATTERN_RE = /^[A-Za-z0-9._/*?-]{1,100}$/;

export function validatePattern(p: string): string | null {
  if (!PATTERN_RE.test(p)) return 'Use letters, digits and . _ - / plus * and ? wildcards (max 100 characters)';
  if (p.includes('..') || p.startsWith('/') || p.endsWith('/') || p.includes('//')) return 'That is not a valid branch name pattern';
  return null;
}

/** Shell-glob semantics (what the pre-receive hook uses): `*` matches any run including `/`, `?` one character. */
export function branchMatches(pattern: string, name: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[t])) {
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

/**
 * A repository's own rules, plus the ones that come from above: the owner's protected release branches (no deletion,
 * no force-push, for admins too) and, under legal hold, no deleting or rewriting any branch.
 *
 * The `require_pull_request` column is ignored: Jumper no longer has pull requests (they live on GitHub), and honouring
 * old rows would lock people out of their own branches.
 */
export const ownRulesFor = (ctx: Ctx, repoId: string): Promise<BranchProtection[]> => ctx.db.select().from(branchProtection).where(eq(branchProtection.repoId, repoId));

export async function rulesFor(ctx: Ctx, repoId: string): Promise<BranchProtection[]> {
  const own = await ownRulesFor(ctx, repoId);
  const row = (await ctx.db.select({ repo: repositories, ns: namespaces }).from(repositories).innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId)).where(eq(repositories.id, repoId)).limit(1))[0];
  if (!row) return own;
  const synthetic = (pattern: string, source: string): BranchProtection => ({
    id: `${source}:${pattern}`,
    repoId,
    pattern,
    blockDeletion: true,
    blockForcePush: true,
    requirePullRequest: false,
    enforceAdmins: true,
    createdBy: null,
    createdAt: new Date(0),
  } as BranchProtection);
  const policy = await effectivePolicy(ctx, row.ns);
  const extra = policy.releaseBranches.map((p) => synthetic(p, 'policy'));
  if (await holdOnRepo(ctx, row.repo)) extra.push(synthetic('*', 'hold'));
  return [...own, ...extra];
}

/** Whether a rule came from the owner's policy or a legal hold rather than the repository's own settings. */
export const isInherited = (r: BranchProtection) => r.id.startsWith('policy:') || r.id.startsWith('hold:');

export interface Effective {
  blockDeletion: boolean;
  blockForcePush: boolean;
}

/** The union of every rule matching `branch`. Admins are exempt from rules that do not enforce admins. */
export function effectiveFor(rules: BranchProtection[], branch: string, isAdmin: boolean): Effective | null {
  const hit = rules.filter((r) => branchMatches(r.pattern, branch) && (!isAdmin || r.enforceAdmins));
  if (!hit.length) return null;
  return {
    blockDeletion: hit.some((r) => r.blockDeletion),
    blockForcePush: hit.some((r) => r.blockForcePush),
  };
}

export async function isProtectedFromDeletion(ctx: Ctx, repoId: string, branch: string, isAdmin: boolean): Promise<boolean> {
  return effectiveFor(await rulesFor(ctx, repoId), branch, isAdmin)?.blockDeletion ?? false;
}

/** Serialise the rules that apply to one pusher for the hook: `glob<TAB>flags`, flags ⊂ {D, F}. */
export function hookRules(rules: BranchProtection[], isAdmin: boolean): string {
  return rules
    .filter((r) => !isAdmin || r.enforceAdmins)
    .map((r) => `${r.pattern}\t${r.blockDeletion ? 'D' : ''}${r.blockForcePush ? 'F' : ''}`)
    .join('\n');
}

/** Enforced by git itself, so it covers every client. Rules come from JUMPER_PROTECT; JUMPER_REFUSE carries a plan-limit refusal. */
export const PRE_RECEIVE_HOOK = `#!/bin/sh
# Jumper branch protection (generated; do not edit).
zero=0000000000000000000000000000000000000000
tab=$(printf '\\t')
fail=0
refused=0
while read -r old new ref; do
  # JUMPER_REFUSE (plan limits): refuse anything that adds or updates a ref; deleting refs is still allowed.
  if [ -n "$JUMPER_REFUSE" ] && [ "$new" != "$zero" ]; then
    [ "$refused" = 1 ] || printf 'error: %s\n' "$JUMPER_REFUSE" >&2
    refused=1; fail=1; continue
  fi
  case "$ref" in refs/heads/*) ;; *) continue ;; esac
  branch=\${ref#refs/heads/}
  while IFS="$tab" read -r pat flags; do
    [ -n "$pat" ] || continue
    case "$branch" in
      $pat)
        case "$flags" in
          *D*) if [ "$new" = "$zero" ]; then echo "error: '$branch' is protected and cannot be deleted." >&2; fail=1; continue; fi ;;
        esac
        case "$flags" in
          *F*) if [ "$old" != "$zero" ] && [ "$new" != "$zero" ] && ! git merge-base --is-ancestor "$old" "$new" 2>/dev/null; then echo "error: '$branch' is protected and cannot be force-pushed." >&2; fail=1; fi ;;
        esac
        ;;
    esac
  done <<JUMPER_RULES
$JUMPER_PROTECT
JUMPER_RULES
done
exit $fail
`;

export function hooksDir(reposDir: string): string {
  return join(reposDir, '.hooks');
}

export async function ensureHooks(reposDir: string): Promise<void> {
  const dir = hooksDir(reposDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'pre-receive');
  await writeFile(file, PRE_RECEIVE_HOOK);
  await chmod(file, 0o755);
}

export async function findRule(ctx: Ctx, repoId: string, id: string): Promise<BranchProtection | undefined> {
  return (await ctx.db.select().from(branchProtection).where(and(eq(branchProtection.id, id), eq(branchProtection.repoId, repoId))).limit(1))[0];
}
