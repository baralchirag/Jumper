// Colours follow KiCad's built-in "KiCad Default" themes so the viewer feels native.

export const PCB_BACKGROUND = 0x001023;

const PCB_LAYER_COLORS: Record<string, number> = {
  'F.Cu': 0xc83434,
  'B.Cu': 0x4d7fc4,
  'F.Adhes': 0x8d5d8d,
  'B.Adhes': 0x0000f8,
  'F.Paste': 0xb4a0a0,
  'B.Paste': 0x00c2c2,
  'F.SilkS': 0xf2eda1,
  'B.SilkS': 0xe8b2a7,
  'F.Mask': 0xd864ff,
  'B.Mask': 0x02ffee,
  'Dwgs.User': 0xc2c2c2,
  'User.Drawings': 0xc2c2c2,
  'Cmts.User': 0x5994dc,
  'User.Comments': 0x5994dc,
  'Eco1.User': 0xb4dbd2,
  'User.Eco1': 0xb4dbd2,
  'Eco2.User': 0xd8c852,
  'User.Eco2': 0xd8c852,
  'Edge.Cuts': 0xd0d2cd,
  Margin: 0xff26e2,
  'F.CrtYd': 0xff26e2,
  'B.CrtYd': 0x26e9ff,
  'F.Fab': 0xafafaf,
  'B.Fab': 0x585d84,
};

const INNER = [0x7fc87f, 0xce7d2c, 0x4fcbcb, 0xdb628b, 0xa7a5c6, 0x28ccd9, 0xe3b72e, 0x6ad09b];

export function pcbLayerColor(layer: string): number {
  const c = PCB_LAYER_COLORS[layer];
  if (c !== undefined) return c;
  const inner = /^In(\d+)\.Cu$/.exec(layer);
  if (inner) return INNER[(Number(inner[1]) - 1) % INNER.length]!;
  if (layer.startsWith('User.')) return 0xc2c2c2;
  return 0x9a9a9a;
}

export const PCB_LAYER_ALPHA: Record<string, number> = {
  'F.Mask': 0.4,
  'B.Mask': 0.4,
  'F.Paste': 0.6,
  'B.Paste': 0.6,
};

export const VIA_COLOR = 0xececec;
export const HOLE_COLOR = 0x1a1a1a;
export const PLATED_HOLE_RING = 0xc2a700;
export const HIGHLIGHT_COLOR = 0xffffff;
export const SELECT_COLOR = 0xff9a3c;

export const SCH = {
  background: 0xf5f4ef,
  page: 0x840000,
  wire: 0x009600,
  bus: 0x0000c8,
  junction: 0x009600,
  noConnect: 0x0000c8,
  body: 0x840000,
  bodyFill: 0xffffc2,
  pin: 0x840000,
  pinName: 0x006464,
  pinNumber: 0xa90000,
  reference: 0x006464,
  value: 0x006464,
  field: 0x840084,
  label: 0x000000,
  globalLabel: 0x840000,
  hierLabel: 0x725600,
  sheet: 0x840084,
  sheetFill: 0xffffff,
  sheetName: 0x006464,
  sheetFile: 0x725600,
  notes: 0x0000c2,
  dnp: 0xdc0000,
} as const;

/** Copper layers in stack order (front to back). */
export function copperOrder(names: string[]): string[] {
  const inner = names
    .filter((n) => /^In\d+\.Cu$/.test(n))
    .sort((a, b) => Number(a.slice(2, -3)) - Number(b.slice(2, -3)));
  return ['F.Cu', ...inner, 'B.Cu'].filter((n) => names.includes(n));
}

/** Draw order for a board viewed from the top (first = bottom-most). */
export function pcbDrawOrder(layers: string[], flipped = false): string[] {
  const copper = copperOrder(layers);
  const back = ['B.Fab', 'B.CrtYd', 'B.Adhes', 'B.SilkS', 'B.Paste', 'B.Mask'];
  const front = ['F.Mask', 'F.Paste', 'F.Adhes', 'F.SilkS', 'F.CrtYd', 'F.Fab'];
  const user = layers.filter((l) => !copper.includes(l) && !back.includes(l) && !front.includes(l) && l !== 'Edge.Cuts');
  let order = [...back, ...[...copper].reverse(), ...front, ...user, 'Edge.Cuts'];
  if (flipped) {
    order = [...[...front].reverse(), ...copper, ...[...back].reverse(), ...user, 'Edge.Cuts'];
  }
  return order.filter((l) => layers.includes(l));
}
