// Search across repositories, file names, file contents, BOM parts and nets.
//
// Repositories are searched in PostgreSQL. Files and code come from git at each repository's default branch;
// parts and nets from the BOM and netlist the checks produced for it. Those are bounded: a global search looks at the
// most recently pushed repositories the viewer can read, a repository search at that one repository.
import { and, artifacts, desc, eq, type User } from '@jumper/db';
import { parseNetlist } from '@jumper/engineering';
import type { SearchHit, SearchResults, SearchType } from '@jumper/shared';
import type { Ctx } from '../../context';
import { gitFor } from '../repos/access';
import { visibleRepos } from '../repos/routes';

const PER_TYPE = 50;
const GLOBAL_REPOS = 25;

interface Target {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

interface BomLineLite {
  references: string[];
  quantity: number;
  value: string;
  footprint: string;
  fields?: Record<string, string>;
}

/** Parsed BOMs and netlists by storage key: artifacts are immutable, so entries never go stale. */
const parsed = new Map<string, unknown>();
function remember<T>(key: string, value: T): T {
  if (parsed.size > 200) parsed.delete(parsed.keys().next().value!);
  parsed.set(key, value);
  return value;
}

const fileLists = new Map<string, string[]>();

async function readArtifact(ctx: Ctx, key: string, max = 16 * 1024 * 1024): Promise<string | null> {
  const obj = await ctx.storage.get(key);
  if (!obj) return null;
  if (obj.size > max) {
    obj.body.destroy();
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const c of obj.body) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

/** The newest artifact of a kind for the default branch head, falling back to the newest one at all. */
async function latestArtifact(ctx: Ctx, t: Target, head: string | null, kind: string, name?: string) {
  const conds = [eq(artifacts.repoId, t.id), eq(artifacts.kind, kind), ...(name ? [eq(artifacts.name, name)] : [])];
  if (head) {
    const atHead = await ctx.db.select().from(artifacts).where(and(...conds, eq(artifacts.sha, head))).limit(5);
    if (atHead.length) return { sha: head, rows: atHead };
  }
  const newest = await ctx.db.select().from(artifacts).where(and(...conds)).orderBy(desc(artifacts.createdAt)).limit(1);
  if (!newest[0]) return null;
  const rows = await ctx.db.select().from(artifacts).where(and(...conds, eq(artifacts.sha, newest[0].sha))).limit(5);
  return { sha: newest[0].sha, rows };
}

const MPN_FIELDS = ['MPN', 'Manufacturer_Part_Number', 'Manufacturer Part Number', 'MFR Part', 'Mfr. No', 'LCSC', 'LCSC Part #', 'Digikey', 'DigiKey_PN', 'Mouser'];

function mpnOf(fields: Record<string, string> = {}): string | null {
  for (const k of MPN_FIELDS) if (fields[k]?.trim()) return fields[k]!.trim();
  return null;
}

async function searchFiles(ctx: Ctx, t: Target, head: string, q: string): Promise<SearchHit[]> {
  let files = fileLists.get(head);
  if (!files) {
    files = await gitFor(ctx, t.id).lsFiles(head).catch(() => []);
    if (fileLists.size > 200) fileLists.delete(fileLists.keys().next().value!);
    fileLists.set(head, files);
  }
  const needle = q.toLowerCase();
  const matches = files.filter((f) => f.toLowerCase().includes(needle));
  // File-name matches before folder matches, then shorter paths.
  matches.sort((a, b) => Number(!a.split('/').pop()!.toLowerCase().includes(needle)) - Number(!b.split('/').pop()!.toLowerCase().includes(needle)) || a.length - b.length);
  return matches.slice(0, PER_TYPE).map((path) => ({ type: 'files' as const, repo: { owner: t.owner, name: t.name }, ref: t.defaultBranch, path }));
}

async function searchCode(ctx: Ctx, t: Target, head: string, q: string): Promise<SearchHit[]> {
  if (q.length < 2) return [];
  const hits = await gitFor(ctx, t.id).grep(head, q, PER_TYPE);
  return hits.map((h) => ({ type: 'code' as const, repo: { owner: t.owner, name: t.name }, ref: t.defaultBranch, path: h.path, line: h.line, text: h.text }));
}

async function searchParts(ctx: Ctx, t: Target, head: string | null, q: string): Promise<SearchHit[]> {
  const found = await latestArtifact(ctx, t, head, 'bom', 'bom.json');
  if (!found) return [];
  const needle = q.toLowerCase();
  const out: SearchHit[] = [];
  for (const a of found.rows) {
    let list = parsed.get(a.storageKey) as BomLineLite[] | undefined;
    if (!list) {
      const text = await readArtifact(ctx, a.storageKey);
      try {
        const data = text ? (JSON.parse(text) as unknown) : [];
        list = Array.isArray(data) ? (data as BomLineLite[]) : [];
      } catch {
        list = [];
      }
      remember(a.storageKey, list);
    }
    for (const l of list) {
      const hay = [l.value, l.footprint, ...(l.references ?? []), ...Object.values(l.fields ?? {})].join(' ').toLowerCase();
      if (!hay.includes(needle)) continue;
      out.push({ type: 'parts', repo: { owner: t.owner, name: t.name }, ref: found.sha, refs: l.references ?? [], value: l.value, footprint: l.footprint, mpn: mpnOf(l.fields), quantity: l.quantity ?? l.references?.length ?? 1 });
      if (out.length >= PER_TYPE) return out;
    }
  }
  return out;
}

async function searchNets(ctx: Ctx, t: Target, head: string | null, q: string): Promise<SearchHit[]> {
  const found = await latestArtifact(ctx, t, head, 'netlist');
  if (!found) return [];
  const needle = q.toLowerCase();
  const out: SearchHit[] = [];
  for (const a of found.rows) {
    let nets = parsed.get(a.storageKey) as { name: string; pads: number }[] | undefined;
    if (!nets) {
      const text = await readArtifact(ctx, a.storageKey, 32 * 1024 * 1024);
      try {
        nets = text ? parseNetlist(text).nets.map((n) => ({ name: n.name, pads: n.nodes.length })) : [];
      } catch {
        nets = [];
      }
      remember(a.storageKey, nets);
    }
    for (const n of nets) {
      if (!n.name.toLowerCase().includes(needle)) continue;
      out.push({ type: 'nets', repo: { owner: t.owner, name: t.name }, ref: found.sha, net: n.name, pads: n.pads });
      if (out.length >= PER_TYPE) return out;
    }
  }
  return out;
}

export async function search(ctx: Ctx, viewer: User | null, q: string, type: SearchType, scope?: Target): Promise<SearchResults> {
  const query = q.trim().slice(0, 200);
  const empty: SearchResults = { query, type, hits: [], counts: {}, truncated: false };
  if (!query) return empty;

  const targets: Target[] = scope
    ? [scope]
    : (await visibleRepos(ctx, viewer, { limit: GLOBAL_REPOS })).map((r) => ({ id: r.id, owner: r.owner, name: r.name, defaultBranch: r.defaultBranch }));
  const heads = new Map<string, string | null>();
  await Promise.all(targets.map(async (t) => heads.set(t.id, await gitFor(ctx, t.id).resolveBranch(t.defaultBranch).catch(() => null))));

  const perRepo = async (fn: (t: Target, head: string | null) => Promise<SearchHit[]>) => {
    const all = await Promise.all(targets.map((t) => fn(t, heads.get(t.id) ?? null).catch(() => [] as SearchHit[])));
    return all.flat();
  };

  const runners: Record<SearchType, () => Promise<SearchHit[]>> = {
    repos: async () =>
      scope
        ? []
        : (await visibleRepos(ctx, viewer, { q: query, limit: PER_TYPE })).map((r) => ({ type: 'repos' as const, repo: { owner: r.owner, name: r.name }, description: r.description, updatedAt: r.pushedAt ?? r.updatedAt })),
    files: () => perRepo((t, head) => (head ? searchFiles(ctx, t, head, query) : Promise.resolve([]))),
    code: () => perRepo((t, head) => (head ? searchCode(ctx, t, head, query) : Promise.resolve([]))),
    parts: () => perRepo((t, head) => searchParts(ctx, t, head, query)),
    nets: () => perRepo((t, head) => searchNets(ctx, t, head, query)),
  };

  const types = Object.keys(runners) as SearchType[];
  const results = await Promise.all(types.map((k) => runners[k]()));
  const counts: Partial<Record<SearchType, number>> = {};
  types.forEach((k, i) => {
    if (!(scope && k === 'repos')) counts[k] = results[i]!.length;
  });
  const hits = results[types.indexOf(type)]!;
  return { query, type, hits: hits.slice(0, 100), counts, truncated: hits.length > 100 || hits.length === PER_TYPE };
}
