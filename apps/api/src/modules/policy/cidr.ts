// Address matching for IP allowlists: plain addresses and CIDR ranges, IPv4 and IPv6.
import { isIP } from 'node:net';

function toBigInt(ip: string): { value: bigint; bits: number } | null {
  let addr = ip.trim();
  // IPv4 reached over an IPv6 socket.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) addr = mapped[1]!;
  const kind = isIP(addr);
  if (kind === 4) {
    const parts = addr.split('.').map(Number);
    return { value: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n), bits: 32 };
  }
  if (kind !== 6) return null;
  const [head, tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = addr.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = addr.includes('::') ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  return { value: groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || '0', 16)), 0n), bits: 128 };
}

export function cidrContains(range: string, ip: string): boolean {
  const [base, prefixText] = range.split('/');
  const b = toBigInt(base ?? '');
  const a = toBigInt(ip);
  if (!a || !b || a.bits !== b.bits) return false;
  const prefix = prefixText === undefined ? b.bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > b.bits) return false;
  const shift = BigInt(b.bits - prefix);
  return a.value >> shift === b.value >> shift;
}

export const ipAllowed = (ranges: string[], ip: string): boolean => ranges.some((r) => cidrContains(r, ip));
