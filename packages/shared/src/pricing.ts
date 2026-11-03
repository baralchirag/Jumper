// BOM sourcing: supplier offers and priced BOM lines.

export const SUPPLIERS = ['LCSC', 'JLCPCB', 'Mouser', 'DigiKey'] as const;
export type Supplier = (typeof SUPPLIERS)[number];

export interface PriceBreak {
  qty: number;
  /** Unit price in USD. */
  price: number;
}

export interface Offer {
  supplier: Supplier;
  /** Supplier part number (e.g. C25804, 595-NE555DR). */
  sku: string;
  mpn: string;
  manufacturer: string;
  description: string;
  package: string | null;
  stock: number;
  moq: number;
  /** Order multiple (reel/tape increments), 1 when unrestricted. */
  multiple: number;
  priceBreaks: PriceBreak[];
  currency: 'USD';
  url: string | null;
  datasheet: string | null;
  image: string | null;
  /** JLCPCB assembly library: basic parts have no setup fee. */
  library: 'basic' | 'preferred' | 'extended' | null;
  /** Manufacturer's product status when the supplier reports it. */
  lifecycle?: Lifecycle | null;
  /** RoHS status when the supplier reports it. */
  rohs?: boolean | null;
}

export const LIFECYCLES = ['active', 'nrnd', 'eol', 'obsolete'] as const;
/** active; nrnd = not recommended for new designs; eol = last-time buy announced; obsolete = no longer made. */
export type Lifecycle = (typeof LIFECYCLES)[number];

/** Read a supplier's or a BOM field's status text ("Obsolete", "Not Recommended for New Designs", "Last Time Buy"). */
export function parseLifecycle(text: string | null | undefined): Lifecycle | null {
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/obsolete|discontinued|no longer (manufactured|available)/.test(t)) return 'obsolete';
  if (/end.of.life|\beol\b|last.time.buy|\bltb\b/.test(t)) return 'eol';
  if (/not.recommended|\bnrnd\b/.test(t)) return 'nrnd';
  if (/active|production|new product|in stock|normal/.test(t)) return 'active';
  return null;
}

/** How a part was identified. */
export type MatchKind = 'sku' | 'mpn' | 'parametric';

export interface PricedOffer extends Offer {
  match: MatchKind;
  /** Quantity to buy after MOQ/multiple rounding. */
  buyQty: number;
  unitPrice: number;
  extended: number;
  inStock: boolean;
}

export interface PricedLine {
  references: string[];
  value: string;
  footprint: string;
  /** Parts needed for the requested number of boards. */
  needed: number;
  dnp: boolean;
  /** Not purchasable (mounting holes, test points, logos, …). */
  skipped: boolean;
  query: { sku: string | null; mpn: string | null; keyword: string | null };
  datasheet: string | null;
  /** Best offer per supplier. */
  offers: Partial<Record<Supplier, PricedOffer>>;
  /** Cheapest in-stock offer across suppliers. */
  best: Supplier | null;
}

export interface SupplierTotal {
  supplier: Supplier;
  total: number;
  /** Lines this supplier can fill (in stock). */
  covered: number;
  enabled: boolean;
  error: string | null;
}

export interface BomPricingResponse {
  sha: string;
  boards: number;
  currency: 'USD';
  lines: PricedLine[];
  suppliers: SupplierTotal[];
  /** Cheapest supplier per line. */
  bestMix: { total: number; covered: number };
  /** Lines that need sourcing (not DNP, not skipped). */
  sourceable: number;
  fetchedAt: string;
}

/** Unit price and buy quantity for `needed` parts. */
export function priceAt(offer: Pick<Offer, 'priceBreaks' | 'moq' | 'multiple'>, needed: number): { buyQty: number; unitPrice: number; extended: number } | null {
  if (!offer.priceBreaks.length) return null;
  const moq = Math.max(1, offer.moq || 1, offer.priceBreaks[0]!.qty);
  const mult = Math.max(1, offer.multiple || 1);
  let buyQty = Math.max(needed, moq);
  if (buyQty % mult) buyQty += mult - (buyQty % mult);
  const sorted = [...offer.priceBreaks].sort((a, b) => a.qty - b.qty);
  let unitPrice = sorted[0]!.price;
  for (const b of sorted) if (b.qty <= buyQty) unitPrice = b.price;
  return { buyQty, unitPrice, extended: Math.round(unitPrice * buyQty * 10000) / 10000 };
}
