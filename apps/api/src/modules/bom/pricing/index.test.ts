import { describe, expect, it } from 'vitest';
import { priceAt, type Offer } from '@jumper/shared';
import { pickJlc } from './index';
import { buildQuery } from './query';

const offer = (p: Partial<Offer>): Offer => ({
  supplier: 'JLCPCB', sku: 'C1', mpn: 'X', manufacturer: 'M', description: '', package: null, stock: 1000, moq: 1, multiple: 1,
  priceBreaks: [{ qty: 1, price: 0.1 }, { qty: 100, price: 0.05 }], currency: 'USD', url: null, datasheet: null, image: null, library: 'extended', ...p,
});

describe('pricing', () => {
  it('applies MOQ, order multiples and price breaks', () => {
    expect(priceAt(offer({}), 10)).toEqual({ buyQty: 10, unitPrice: 0.1, extended: 1 });
    expect(priceAt(offer({}), 150)).toEqual({ buyQty: 150, unitPrice: 0.05, extended: 7.5 });
    expect(priceAt(offer({ moq: 100, priceBreaks: [{ qty: 100, price: 0.002 }] }), 4)).toEqual({ buyQty: 100, unitPrice: 0.002, extended: 0.2 });
    expect(priceAt(offer({ multiple: 5 }), 7)?.buyQty).toBe(10);
  });

  it('prefers basic-library, in-stock parts for parametric matches', () => {
    const q = buildQuery({ references: ['R1'], quantity: 1, value: '10k', footprint: 'R_0603_1608Metric', libId: 'Device:R', dnp: false, fields: {} });
    const pick = pickJlc([offer({ sku: 'C9', stock: 9e6 }), offer({ sku: 'C2', library: 'basic', stock: 5000 }), offer({ sku: 'C3', library: 'basic', stock: 0 })], q, 10);
    expect(pick).toEqual({ offer: expect.objectContaining({ sku: 'C2' }), match: 'parametric' });
  });

  it('requires an exact code or MPN match', () => {
    const q = buildQuery({ references: ['U1'], quantity: 1, value: 'TP4056', footprint: 'SOIC-8', libId: 'x:y', dnp: false, fields: { MPN: 'TP4056-42-ESOP8' } });
    expect(pickJlc([offer({ mpn: 'TP4056-42-EMSOP8', sku: 'C21417' }), offer({ mpn: 'TP4056-42-ESOP8', sku: 'C16581' })], q, 1)?.offer.sku).toBe('C16581');
    const coded = buildQuery({ references: ['R1'], quantity: 1, value: '10k', footprint: '', libId: '', dnp: false, fields: { LCSC: 'C55' } });
    expect(pickJlc([offer({ sku: 'C6' })], coded, 1)).toBeNull();
  });
});
