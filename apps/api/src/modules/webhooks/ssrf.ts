import { BlockList, isIP } from 'node:net';

// Address ranges a webhook must never reach (SSRF protection): loopback, private, link-local (cloud metadata),
// carrier-grade NAT, documentation/benchmark and multicast/reserved ranges.
const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['64:ff9b::', 96],
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

/** True when `ip` is a non-public address. IPv4-mapped IPv6 addresses are unwrapped first. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped ? mapped[1]! : ip;
  const family = isIP(addr);
  if (family === 0) return true; // not an IP: refuse
  return blocked.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

/** Validate a webhook URL at registration time. Throws a message suitable for the user. */
export function assertWebhookUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not allowed');
  if (!allowPrivate) {
    if (u.protocol !== 'https:') throw new Error('Webhook URLs must use https');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('Webhook URLs must be publicly reachable');
    if (isIP(host) && isPrivateAddress(host)) throw new Error('Webhook URLs must be publicly reachable');
  }
  return u;
}
