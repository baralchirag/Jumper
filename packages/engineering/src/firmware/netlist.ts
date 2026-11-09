// Parser for KiCad s-expression netlists (`kicad-cli sch export netlist --format kicadsexpr`).
import type { PinAssignment } from './pinmap';

export type SNode = string | SNode[];

/** Minimal s-expression reader. Depth and size are bounded so hostile input cannot exhaust the stack. */
export function parseSexpr(text: string, maxDepth = 64): SNode[] {
  const stack: SNode[][] = [[]];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '(') {
      if (stack.length > maxDepth) throw new Error('netlist nesting is too deep');
      const list: SNode[] = [];
      stack[stack.length - 1]!.push(list);
      stack.push(list);
      i++;
    } else if (c === ')') {
      if (stack.length === 1) throw new Error('unbalanced ")" in netlist');
      stack.pop();
      i++;
    } else if (c === '"') {
      let s = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) i++;
        s += text[i++];
      }
      if (i >= n) throw new Error('unterminated string in netlist');
      i++;
      stack[stack.length - 1]!.push(s);
    } else if (/\s/.test(c)) i++;
    else {
      let j = i;
      while (j < n && !/[\s()"]/.test(text[j]!)) j++;
      stack[stack.length - 1]!.push(text.slice(i, j));
      i = j;
    }
  }
  if (stack.length !== 1) throw new Error('unbalanced "(" in netlist');
  return stack[0]!;
}

const head = (n: SNode): string | null => (Array.isArray(n) && typeof n[0] === 'string' ? n[0] : null);
const child = (n: SNode[], name: string): SNode[] | undefined => n.find((c): c is SNode[] => head(c) === name);
const val = (n: SNode[], name: string): string | undefined => {
  const c = child(n, name);
  return typeof c?.[1] === 'string' ? c[1] : undefined;
};

export interface NetlistNode {
  ref: string;
  pin: string;
  pinFunction: string | null;
  pinType: string | null;
}
export interface Netlist {
  components: { ref: string; value: string; footprint: string }[];
  nets: { name: string; nodes: NetlistNode[] }[];
}

export function parseNetlist(text: string): Netlist {
  const root = parseSexpr(text).find((n): n is SNode[] => head(n) === 'export');
  if (!root) throw new Error('not a KiCad netlist (missing "export")');
  const comps = child(root, 'components') ?? [];
  const nets = child(root, 'nets') ?? [];
  return {
    components: comps.flatMap((c) => {
      if (head(c) !== 'comp') return [];
      const l = c as SNode[];
      return [{ ref: val(l, 'ref') ?? '', value: val(l, 'value') ?? '', footprint: val(l, 'footprint') ?? '' }];
    }),
    nets: nets.flatMap((nt) => {
      if (head(nt) !== 'net') return [];
      const l = nt as SNode[];
      return [
        {
          name: val(l, 'name') ?? '',
          nodes: l.flatMap((x) => {
            if (head(x) !== 'node') return [];
            const nl = x as SNode[];
            return [{ ref: val(nl, 'ref') ?? '', pin: val(nl, 'pin') ?? '', pinFunction: val(nl, 'pinfunction') ?? null, pinType: val(nl, 'pintype') ?? null }];
          }),
        },
      ];
    }),
  };
}

/** Pin → net assignments of one component (usually the MCU). Pin names come from the symbol's pin function. */
export function pinAssignments(netlist: Netlist, ref: string): PinAssignment[] {
  const out: PinAssignment[] = [];
  for (const net of netlist.nets) {
    for (const node of net.nodes) {
      if (node.ref === ref) out.push({ pin: node.pinFunction || node.pin, net: net.name });
    }
  }
  return out;
}

/** Components that look like microcontrollers (many connected GPIO-style pins), most pins first. */
export function candidateMcus(netlist: Netlist): { ref: string; value: string; pins: number }[] {
  const counts = new Map<string, number>();
  for (const net of netlist.nets) for (const n of net.nodes) counts.set(n.ref, (counts.get(n.ref) ?? 0) + 1);
  return netlist.components
    .map((c) => ({ ref: c.ref, value: c.value, pins: counts.get(c.ref) ?? 0 }))
    .filter((c) => c.pins >= 8 && /^U/i.test(c.ref))
    .sort((a, b) => b.pins - a.pins);
}
