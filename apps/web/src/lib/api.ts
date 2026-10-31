import type { ApiErrorBody } from '@pcbhub/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function url(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `/api${path}${s ? `?${s}` : ''}`;
}

async function request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url(path, opts.query), {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'pcbhub',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? res.statusText, body.details);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** Raw file contents (text) at a revision. */
export async function fetchRaw(owner: string, repo: string, ref: string, path: string): Promise<string> {
  const res = await fetch(url(`/repos/${owner}/${repo}/raw`, { ref, path }), { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, 'raw_failed', `Could not load ${path}`);
  return res.text();
}

export function rawUrl(owner: string, repo: string, ref: string, path: string): string {
  return url(`/repos/${owner}/${repo}/raw`, { ref, path });
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const blockers = (e.details as { blockers?: string[] } | undefined)?.blockers;
    return blockers?.length ? `${e.message}: ${blockers.join('; ')}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function repoPath(owner: string, repo: string, rest = ''): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${rest}`;
}
