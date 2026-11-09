// Mouser and DigiKey (need API credentials; disabled otherwise).
import { parseLifecycle, type Offer } from '@jumper/shared';
import { fetchJson, SupplierError } from './http';

const num = (s: string | number | null | undefined) => (typeof s === 'number' ? s : Number(String(s ?? '').replace(/[^0-9.]/g, '')) || 0);

interface MouserPart {
  MouserPartNumber: string;
  ManufacturerPartNumber: string;
  Manufacturer: string;
  Description: string;
  Availability: string | null;
  AvailabilityInStock: string | null;
  Min: string;
  Mult: string;
  PriceBreaks: { Quantity: number; Price: string; Currency: string }[];
  ProductDetailUrl: string | null;
  DataSheetUrl: string | null;
  ImagePath: string | null;
  LifecycleStatus?: string | null;
  ROHSStatus?: string | null;
}

/** "RoHS Compliant", "RoHS Compliant By Exemption", "ROHS3 Compliant" are yes; "Non-Compliant" / "Not Compliant" are no. */
export function parseRohs(text: string | null | undefined): boolean | null {
  const t = (text ?? '').trim().toLowerCase();
  if (!t || /unknown|not applicable|n\/a|pending/.test(t)) return null;
  if (/non.?compliant|not compliant|not rohs/.test(t)) return false;
  return /compliant|rohs|yes/.test(t) ? true : null;
}

export async function mouserSearch(apiKey: string, query: { partNumber?: string; keyword?: string }): Promise<Offer[]> {
  const base = 'https://api.mouser.com/api/v1/search';
  const body = query.partNumber
    ? { SearchByPartRequest: { mouserPartNumber: query.partNumber, partSearchOptions: 'Exact' } }
    : { SearchByKeywordRequest: { keyword: query.keyword, records: 10, startingRecord: 0, searchOptions: 'InStock' } };
  const r = await fetchJson<{ Errors: { Message: string }[]; SearchResults: { Parts: MouserPart[] } | null }>(
    `${base}/${query.partNumber ? 'partnumber' : 'keyword'}?apiKey=${encodeURIComponent(apiKey)}`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (r.Errors?.length) throw new SupplierError(`Mouser: ${r.Errors[0]!.Message}`);
  return (r.SearchResults?.Parts ?? [])
    .filter((p) => p.PriceBreaks?.length)
    .map((p) => ({
      supplier: 'Mouser' as const,
      sku: p.MouserPartNumber,
      mpn: p.ManufacturerPartNumber,
      manufacturer: p.Manufacturer,
      description: p.Description,
      package: null,
      stock: num(p.AvailabilityInStock ?? p.Availability),
      moq: Math.max(1, num(p.Min)),
      multiple: Math.max(1, num(p.Mult)),
      // Prices are in the account's currency; Mouser API keys default to USD.
      priceBreaks: p.PriceBreaks.map((b) => ({ qty: b.Quantity, price: num(b.Price) })),
      currency: 'USD' as const,
      url: p.ProductDetailUrl,
      datasheet: p.DataSheetUrl,
      image: p.ImagePath,
      library: null,
      // Mouser leaves LifecycleStatus empty for parts in normal production.
      lifecycle: parseLifecycle(p.LifecycleStatus) ?? 'active',
      rohs: parseRohs(p.ROHSStatus),
    }));
}

let digikeyToken: { value: string; expires: number } | null = null;

async function digikeyAuth(clientId: string, secret: string): Promise<string> {
  if (digikeyToken && digikeyToken.expires > Date.now() + 30_000) return digikeyToken.value;
  const res = await fetch('https://api.digikey.com/v1/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new SupplierError(`DigiKey auth failed (${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  digikeyToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

interface DigikeyProduct {
  ManufacturerProductNumber: string;
  Manufacturer: { Name: string };
  Description: { ProductDescription: string };
  QuantityAvailable: number;
  ProductUrl: string | null;
  DatasheetUrl: string | null;
  PhotoUrl: string | null;
  ProductStatus?: { Status?: string | null } | null;
  Classifications?: { RohsStatus?: string | null } | null;
  ProductVariations: { DigiKeyProductNumber: string; MinimumOrderQuantity: number; StandardPricing: { BreakQuantity: number; UnitPrice: number }[]; PackageType: { Name: string } }[];
}

export async function digikeySearch(clientId: string, secret: string, keyword: string): Promise<Offer[]> {
  const token = await digikeyAuth(clientId, secret);
  const r = await fetchJson<{ Products: DigikeyProduct[]; ExactMatches?: DigikeyProduct[] }>('https://api.digikey.com/products/v4/search/keyword', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'X-DIGIKEY-Client-Id': clientId, 'X-DIGIKEY-Locale-Currency': 'USD' },
    body: JSON.stringify({ Keywords: keyword, Limit: 10, Offset: 0 }),
  });
  const products = [...(r.ExactMatches ?? []), ...(r.Products ?? [])];
  return products.flatMap((p) => {
    // Cut tape is the variation that sells in small quantities.
    const v = p.ProductVariations.find((x) => /cut tape/i.test(x.PackageType?.Name ?? '')) ?? p.ProductVariations.find((x) => x.StandardPricing.length) ?? null;
    if (!v?.StandardPricing.length) return [];
    return [
      {
        supplier: 'DigiKey' as const,
        sku: v.DigiKeyProductNumber,
        mpn: p.ManufacturerProductNumber,
        manufacturer: p.Manufacturer.Name,
        description: p.Description.ProductDescription,
        package: null,
        stock: p.QuantityAvailable,
        moq: Math.max(1, v.MinimumOrderQuantity),
        multiple: 1,
        priceBreaks: v.StandardPricing.map((b) => ({ qty: b.BreakQuantity, price: b.UnitPrice })),
        currency: 'USD' as const,
        url: p.ProductUrl,
        datasheet: p.DatasheetUrl,
        image: p.PhotoUrl,
        library: null,
        lifecycle: parseLifecycle(p.ProductStatus?.Status),
        rohs: parseRohs(p.Classifications?.RohsStatus),
      },
    ];
  });
}
