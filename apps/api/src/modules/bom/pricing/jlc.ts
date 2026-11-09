// JLCPCB parts library (assembly pricing, basic/extended status) and LCSC store pricing.
import type { Offer } from '@jumper/shared';
import { fetchJson } from './http';

interface JlcComponent {
  componentCode: string;
  componentModelEn: string;
  componentBrandEn: string;
  componentLibraryType: 'base' | 'expand' | string;
  preferredComponentFlag: boolean;
  stockCount: number;
  minPurchaseNum: number;
  componentSpecificationEn: string;
  describe: string;
  componentPrices: { startNumber: number; endNumber: number; productPrice: number }[];
  lcscGoodsUrl: string | null;
  urlSuffix: string | null;
  dataManualUrl: string | null;
  dataManualOfficialLink: string | null;
}

interface JlcSearch {
  code: number;
  data: { componentPageInfo: { total: number; list: JlcComponent[] | null } } | null;
}

const SEARCH = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';

export async function jlcSearch(keyword: string, pageSize = 10): Promise<JlcComponent[]> {
  const r = await fetchJson<JlcSearch>(SEARCH, { method: 'POST', body: JSON.stringify({ keyword, currentPage: 1, pageSize }) });
  return r.data?.componentPageInfo.list ?? [];
}

export function jlcOffer(c: JlcComponent): Offer {
  return {
    supplier: 'JLCPCB',
    sku: c.componentCode,
    mpn: c.componentModelEn,
    manufacturer: c.componentBrandEn,
    description: c.describe,
    package: c.componentSpecificationEn || null,
    stock: c.stockCount,
    moq: Math.max(1, c.minPurchaseNum || 1),
    multiple: 1,
    priceBreaks: c.componentPrices.map((p) => ({ qty: p.startNumber, price: p.productPrice })).sort((a, b) => a.qty - b.qty),
    currency: 'USD',
    url: c.urlSuffix ? `https://jlcpcb.com/partdetail/${c.urlSuffix}` : `https://jlcpcb.com/parts/componentSearch?searchTxt=${c.componentCode}`,
    datasheet: c.dataManualUrl || c.dataManualOfficialLink || null,
    image: null,
    library: c.componentLibraryType === 'base' ? 'basic' : c.preferredComponentFlag ? 'preferred' : 'extended',
  };
}

interface LcscDetail {
  code: number;
  result: {
    productCode: string;
    productModel: string;
    brandNameEn: string;
    encapStandard: string | null;
    productIntroEn: string | null;
    stockNumber: number;
    minBuyNumber: number;
    split: number | null;
    productPriceList: { ladder: number; usdPrice: number | null; productPrice: string }[] | null;
    pdfUrl: string | null;
    productImages: string[] | null;
  } | null;
}

export async function lcscProduct(code: string): Promise<Offer | null> {
  const r = await fetchJson<LcscDetail>(`https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=${encodeURIComponent(code)}`);
  const p = r.result;
  if (!p) return null;
  return {
    supplier: 'LCSC',
    sku: p.productCode,
    mpn: p.productModel,
    manufacturer: p.brandNameEn,
    description: p.productIntroEn ?? '',
    package: p.encapStandard,
    stock: p.stockNumber,
    moq: Math.max(1, p.minBuyNumber || 1),
    multiple: Math.max(1, p.split || 1),
    priceBreaks: (p.productPriceList ?? []).map((b) => ({ qty: b.ladder, price: b.usdPrice ?? Number(b.productPrice) })).filter((b) => b.price > 0),
    currency: 'USD',
    url: `https://www.lcsc.com/product-detail/${p.productCode}.html`,
    datasheet: p.pdfUrl,
    image: p.productImages?.[0] ?? null,
    library: null,
  };
}
