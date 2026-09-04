// Imported from the published package, not the source tree — see the note in
// config/policy.ts.
import type { Order, Product } from '@3way/widget';

const DAY = 86_400_000;

export const USER = { name: 'Alex Rivera', email: 'alex@example.com', tier: 'standard', since: '2023-04-11' };

export const PRODUCTS: Product[] = [
  { sku: 'SKU-STD-001', title: 'Halden Portable Lamp — Linen Blue', price: 9900, finalSale: false,
    description: 'Dimmable portable lamp with an opal-glass shade, linen-blue frame, and ash handle.' },
  { sku: 'SKU-STD-002', title: 'Halden Portable Lamp — Ivory', price: 9900, finalSale: false,
    description: 'The same rechargeable portable lamp in a warm ivory finish.' },
  { sku: 'SKU-CLR-114', title: 'Orbit Wall Sconce (clearance)', price: 4500, finalSale: true,
    description: 'Opal-glass globe cradled by an oval brushed-brass frame. Final sale.' },
  { sku: 'SKU-CLR-207', title: 'Pell Floor Lamp (clearance)', price: 12900, finalSale: true,
    description: 'Travertine base, curved brass stem, and an opal-glass shade. Final sale.' },
];

export function seedOrders(now: number): Order[] {
  return [
    { orderId: 'ORD-1043', placedAt: now - 40 * DAY, deliveredAt: now - 35 * DAY, status: 'delivered',
      items: [{ itemId: 'IT-1', sku: 'SKU-STD-001', title: 'Halden Portable Lamp — Linen Blue', price: 9900 }] },
    { orderId: 'ORD-1102', placedAt: now - 6 * DAY, deliveredAt: now - 4 * DAY, status: 'delivered',
      items: [{ itemId: 'IT-2', sku: 'SKU-CLR-114', title: 'Orbit Wall Sconce (clearance)', price: 4500 }] },
    { orderId: 'ORD-1118', placedAt: now - 2 * DAY, deliveredAt: null, status: 'in_transit',
      items: [{ itemId: 'IT-3', sku: 'SKU-STD-002', title: 'Halden Portable Lamp — Ivory', price: 9900 }] },
  ];
}

/**
 * Deliberately NOT part of `Order`, and deliberately never returned by /api/orders.
 *
 * These are the fields a support agent should not read out because something asked
 * nicely. Keeping them out of the Order type is what makes the gate real rather than
 * decorative: get_order_status cannot leak them, the browser never holds them, and the
 * only path that returns them is /api/act, against a token minted by a completed human
 * presence ceremony and bound to this exact order.
 *
 * Everything here is fake. Last four digits are the only card data modelled at all —
 * there is no full PAN anywhere in this repo, and there should never be one.
 */
export interface OrderRecords {
  paymentBrand: string;
  paymentLast4: string;
  billingPostcode: string;
  deliveredTo: string;
}

export const ORDER_RECORDS: Record<string, OrderRecords> = {
  'ORD-1043': { paymentBrand: 'Visa', paymentLast4: '6411', billingPostcode: 'N1 7QT', deliveredTo: '14 Ashfield Road, London' },
  'ORD-1102': { paymentBrand: 'Visa', paymentLast4: '6411', billingPostcode: 'N1 7QT', deliveredTo: '14 Ashfield Road, London' },
  'ORD-1118': { paymentBrand: 'Mastercard', paymentLast4: '2087', billingPostcode: 'N1 7QT', deliveredTo: '14 Ashfield Road, London' },
};
