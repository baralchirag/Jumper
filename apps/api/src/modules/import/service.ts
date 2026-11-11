import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { badRequest } from '../../lib/errors';
import { assertWebhookUrl, isPrivateAddress } from '../webhooks/ssrf';

export interface RemoteTarget {
  url: URL;
  /** `git -c` settings that pin the validated address, forbid redirects and refuse every non-HTTP protocol. */
  config: string[];
}

/**
 * Validate a remote to import from and pin the address we checked, so DNS cannot change between the check and the
 * connection (rebinding). Only http(s) is accepted: `file://`, `ssh://`, `git://` and `ext::` would read the server's own
 * disk or network. Private networks are refused unless the operator allowed them (development only).
 */
export async function resolveRemote(raw: string, allowPrivate: boolean): Promise<RemoteTarget> {
  if (/^ext::|^fd::/i.test(raw.trim())) throw badRequest('Only http(s) URLs can be imported');
  let url: URL;
  try {
    url = assertWebhookUrl(raw.trim(), allowPrivate);
  } catch (e) {
    throw badRequest((e as Error).message === 'Webhook URLs must use https' ? 'Use an https:// URL' : (e as Error).message.replace(/^Webhook URLs/, 'Import URLs'));
  }
  if (url.search || url.hash) throw badRequest('Remove the query string or fragment from the URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  let address = host;
  if (!isIP(host)) {
    let found: { address: string }[];
    try {
      found = await dns.lookup(host, { all: true });
    } catch {
      throw badRequest(`Could not find the server "${host}"`);
    }
    if (!found.length) throw badRequest(`Could not find the server "${host}"`);
    if (!allowPrivate && found.some((a) => isPrivateAddress(a.address))) throw badRequest('That address is not publicly reachable');
    address = found[0]!.address;
  } else if (!allowPrivate && isPrivateAddress(host)) {
    throw badRequest('That address is not publicly reachable');
  }
  return {
    url,
    config: [
      'protocol.allow=never',
      'protocol.https.allow=always',
      ...(allowPrivate ? ['protocol.http.allow=always'] : []),
      'http.followRedirects=false',
      `http.curloptResolve=${host}:${port}:${address}`,
      'core.askPass=true',
      'credential.helper=',
    ],
  };
}

export function repoNameFromUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 100);
}

/** Turn git's stderr into something a person can act on, without echoing the URL (it may hold a token). */
export function friendlyGitError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (/authentication failed|invalid username or password|could not read username|http (401|403)|returned error: 40[13]/.test(s)) {
    return 'The server refused access. For a private repository, enter a username and an access token.';
  }
  if (/not found|returned error: 404|repository .* does not exist/.test(s)) return 'No repository was found at that URL.';
  if (/timed out|timeout|aborted/.test(s)) return 'The server took too long to respond.';
  if (/could not resolve host|couldn't resolve/.test(s)) return 'Could not reach that server.';
  if (/ssl|certificate/.test(s)) return 'The server’s HTTPS certificate could not be verified.';
  return 'Git could not read a repository from that URL.';
}

export function parseDefaultBranch(lsRemote: string): { branch: string | null; empty: boolean } {
  const sym = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(lsRemote);
  return { branch: sym?.[1] ?? null, empty: lsRemote.trim() === '' };
}
