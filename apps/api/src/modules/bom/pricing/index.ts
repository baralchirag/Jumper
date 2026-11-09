// Multi-supplier BOM pricing.
import type { Redis } from 'ioredis';
import type { BomLine } from '@jumper/kicad-core/types';
import { priceAt, SUPPLIERS, type BomPricingResponse, type MatchKind, type Offer, type PricedLine, type PricedOffer, type Supplier, type SupplierTotal } from '@jumper/shared';
import { digikeySearch, mouserSearch } from './distributors';
import { mapLimit, PriceCache } from './http';
import { jlcOffer, jlcSearch, lcscProduct } from './jlc';
import { buildQuery, type PartQuery } from './query';

export interface PricingConfig {
  mouserApiKey?: string;
  digikeyClientId?: string;
  digikeyClientSecret?: string;
}

const LIB_RANK = { basic: 0, preferred: 1, extended: 2 } as const;

/** Pick the JLCPCB result that best matches the query. */
export function pickJlc(results: Offer[], q: PartQuery, needed: number): { offer: Offer; match: MatchKind } | null {
  if (!results.length) return null;
  if (q.lcsc) {
    const hit = results.find((r) => r.sku === q.lcsc);
    return hit ? { offer: hit, match: 'sku' } : null;
  }
  if (q.mpn) {
    const want = q.mpn.toLowerCase();
    const exact = results.find((r) => r.mpn.toLowerCase() === want);
    const prefix = results.filter((r) => r.mpn.toLowerCase().startsWith(want) || want.startsWith(r.mpn.toLowerCase())).sort((a, b) => b.stock - a.stock)[0];
    const hit = exact ?? prefix;
    return hit ? { offer: hit, match: 'mpn' } : null;
  }
  const ranked = [...results].sort(
    (a, b) =>
      Number(b.stock >= needed) - Number(a.stock >= needed) ||
      LIB_RANK[a.library ?? 'extended'] - LIB_RANK[b.library ?? 'extended'] ||
      b.stock - a.stock,
  );
  return { offer: ranked[0]!, match: 'parametric' };
}

function priced(offer: Offer, match: MatchKind, needed: number): PricedOffer | null {
  const p = priceAt(offer, needed);
  if (!p) return null;
  return { ...offer, match, ...p, inStock: offer.stock >= p.buyQty };
}

export async function priceBom(
  lines: BomLine[],
  boards: number,
  opts: { redis: Redis | null; config: PricingConfig; refresh?: boolean },
): Promise<Omit<BomPricingResponse, 'sha'>> {
  const cache = new PriceCache(opts.redis);
  const { config } = opts;
  const errors: Partial<Record<Supplier, string>> = {};
  const enabled: Record<Supplier, boolean> = {
    LCSC: true,
    JLCPCB: true,
    Mouser: Boolean(config.mouserApiKey),
    DigiKey: Boolean(config.digikeyClientId && config.digikeyClientSecret),
  };
  const guard = async <T>(supplier: Supplier, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      errors[supplier] ??= (e as Error).message.slice(0, 200);
      return null;
    }
  };

  const priceLine = async (line: BomLine): Promise<PricedLine> => {
    const q = buildQuery(line);
    const needed = line.quantity * boards;
    const out: PricedLine = {
      references: line.references,
      value: line.value,
      footprint: line.footprint,
      needed,
      dnp: line.dnp,
      skipped: q.skip,
      query: { sku: q.lcsc ?? q.mouser ?? q.digikey, mpn: q.mpn, keyword: q.keyword },
      datasheet: q.datasheet,
      offers: {},
      best: null,
    };
    if (line.dnp || q.skip) return out;

    const term = q.lcsc ?? q.mpn ?? q.keyword;
    const jlc = term
      ? await guard('JLCPCB', () => cache.wrap(`jlc:${term.toLowerCase()}`, async () => (await jlcSearch(term, q.keyword ? 20 : 10)).map(jlcOffer), opts.refresh))
      : null;
    const pick = jlc ? pickJlc(jlc, q, needed) : null;
    if (pick) {
      const o = priced(pick.offer, pick.match, needed);
      if (o) out.offers.JLCPCB = o;
    }
    const code = q.lcsc ?? pick?.offer.sku ?? null;
    const crossMpn = q.mpn ?? (pick && pick.match !== 'parametric' ? pick.offer.mpn : (pick?.offer.mpn ?? null));
    const match: MatchKind = q.lcsc ? 'sku' : q.mpn ? 'mpn' : pick?.match ?? 'parametric';

    await Promise.all([
      code &&
        guard('LCSC', async () => {
          const offer = await cache.wrap(`lcsc:${code}`, () => lcscProduct(code), opts.refresh);
          const o = offer && priced(offer, match, needed);
          if (o) out.offers.LCSC = o;
        }),
      enabled.Mouser &&
        (q.mouser || crossMpn) &&
        guard('Mouser', async () => {
          const key = q.mouser ? `pn:${q.mouser}` : `kw:${crossMpn}`;
          const offers = await cache.wrap(`mouser:${key.toLowerCase()}`, () => mouserSearch(config.mouserApiKey!, q.mouser ? { partNumber: q.mouser } : { keyword: crossMpn! }), opts.refresh);
          const want = (crossMpn ?? '').toLowerCase();
          const hit = offers.find((x) => x.mpn.toLowerCase() === want) ?? offers.sort((a, b) => b.stock - a.stock)[0];
          const o = hit && priced(hit, q.mouser ? 'sku' : match, needed);
          if (o) out.offers.Mouser = o;
        }),
      enabled.DigiKey &&
        (q.digikey || crossMpn) &&
        guard('DigiKey', async () => {
          const kw = q.digikey ?? crossMpn!;
          const offers = await cache.wrap(`digikey:${kw.toLowerCase()}`, () => digikeySearch(config.digikeyClientId!, config.digikeyClientSecret!, kw), opts.refresh);
          const want = (crossMpn ?? '').toLowerCase();
          const hit = offers.find((x) => x.sku === q.digikey || x.mpn.toLowerCase() === want) ?? offers.sort((a, b) => b.stock - a.stock)[0];
          const o = hit && priced(hit, q.digikey ? 'sku' : match, needed);
          if (o) out.offers.DigiKey = o;
        }),
    ]);

    out.datasheet ??= out.offers.LCSC?.datasheet ?? out.offers.JLCPCB?.datasheet ?? out.offers.Mouser?.datasheet ?? out.offers.DigiKey?.datasheet ?? null;
    let best: PricedOffer | null = null;
    for (const s of SUPPLIERS) {
      const o = out.offers[s];
      if (o?.inStock && (!best || o.extended < best.extended)) best = o;
    }
    out.best = best?.supplier ?? null;
    return out;
  };

  const priced_ = await mapLimit(lines, 6, priceLine);
  const sourceable = priced_.filter((l) => !l.dnp && !l.skipped);
  const suppliers: SupplierTotal[] = SUPPLIERS.map((s) => {
    const filled = sourceable.filter((l) => l.offers[s]?.inStock);
    return {
      supplier: s,
      total: round(filled.reduce((n, l) => n + l.offers[s]!.extended, 0)),
      covered: filled.length,
      enabled: enabled[s],
      error: enabled[s] ? (errors[s] ?? null) : s === 'Mouser' ? 'Set MOUSER_API_KEY to enable' : 'Set DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET to enable',
    };
  });
  const mix = sourceable.filter((l) => l.best);
  return {
    boards,
    currency: 'USD',
    lines: priced_,
    suppliers,
    bestMix: { total: round(mix.reduce((n, l) => n + l.offers[l.best!]!.extended, 0)), covered: mix.length },
    sourceable: sourceable.length,
    fetchedAt: new Date().toISOString(),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
