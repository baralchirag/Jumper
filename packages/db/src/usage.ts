import { sql } from 'drizzle-orm';
import type { Database } from './client';

export interface NamespaceUsageRow {
  repositoriesBytes: number;
  outputsBytes: number;
  largeFilesBytes: number;
  checkMinutes: number;
  seats: number;
}

export interface RepoUsageRow {
  id: string;
  name: string;
  sizeBytes: number;
  outputsBytes: number;
  checkMinutes: number;
}

/** First instant of the current calendar month in UTC (check minutes reset then). */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const rows = <T>(r: unknown) => r as T[];

// Wall-clock minutes per commit and lane: checks (ERC, DRC, BOM) and outputs (renders, exports) run as two jobs on two
// queues. Each lane is billed from its first start to its last finish and rounded up once, so time an outputs job spends
// waiting in the queue is never billed.
const minutesPerRepo = (since: Date) => sql`
  select repo_id, sum(m)::int as minutes from (
    select cr.repo_id, ceil(extract(epoch from (max(cr.completed_at) - min(cr.started_at))) / 60.0) as m
    from check_runs cr
    where cr.started_at is not null and cr.completed_at is not null and cr.completed_at >= ${since.toISOString()}
    group by cr.repo_id, cr.sha, (cr.name in ('Render', 'Exports'))
  ) per_commit group by repo_id`;

/** Storage, check minutes and seats for one namespace (a user or an organization). */
export async function namespaceUsage(db: Database, namespaceId: string, now = new Date()): Promise<NamespaceUsageRow> {
  const since = monthStart(now);
  const [r] = rows<Record<string, string | number | null>>(
    await db.execute(sql`
      with ns as (select id, kind, user_id, org_id from namespaces where id = ${namespaceId}),
      repos as (select r.id, r.size_bytes, r.visibility from repositories r where r.namespace_id = ${namespaceId}),
      minutes as (${minutesPerRepo(since)})
      select
        (select coalesce(sum(size_bytes), 0) from repos)::bigint as repositories_bytes,
        (select coalesce(sum(a.size), 0) from artifacts a where a.repo_id in (select id from repos))::bigint as outputs_bytes,
        (select coalesce(sum(o.size), 0) from lfs_objects o where o.repo_id in (select id from repos))::bigint as large_files_bytes,
        (select coalesce(sum(m.minutes), 0) from minutes m where m.repo_id in (select id from repos))::int as check_minutes,
        case
          when (select kind from ns) = 'org' then (select count(*) from org_members om where om.org_id = (select org_id from ns))
          else 1 + (select count(distinct c.user_id) from repo_collaborators c
                    where c.repo_id in (select id from repos where visibility = 'private')
                      and c.user_id is distinct from (select user_id from ns))
        end::int as seats
    `),
  );
  return {
    repositoriesBytes: Number(r?.repositories_bytes ?? 0),
    outputsBytes: Number(r?.outputs_bytes ?? 0),
    largeFilesBytes: Number(r?.large_files_bytes ?? 0),
    checkMinutes: Number(r?.check_minutes ?? 0),
    seats: Number(r?.seats ?? 1),
  };
}

/** Per-repository breakdown for the usage page, largest first. */
export async function repositoryUsage(db: Database, namespaceId: string, now = new Date()): Promise<RepoUsageRow[]> {
  const since = monthStart(now);
  const result = rows<Record<string, string | number>>(
    await db.execute(sql`
      with minutes as (${minutesPerRepo(since)})
      select r.id, r.name, r.size_bytes,
        (select coalesce(sum(a.size), 0) from artifacts a where a.repo_id = r.id)::bigint
          + (select coalesce(sum(o.size), 0) from lfs_objects o where o.repo_id = r.id)::bigint as outputs_bytes,
        coalesce((select m.minutes from minutes m where m.repo_id = r.id), 0)::int as check_minutes
      from repositories r where r.namespace_id = ${namespaceId}
      order by r.size_bytes desc, r.name limit 50
    `),
  );
  return result.map((x) => ({ id: String(x.id), name: String(x.name), sizeBytes: Number(x.size_bytes), outputsBytes: Number(x.outputs_bytes), checkMinutes: Number(x.check_minutes) }));
}
