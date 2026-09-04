// Plain-JS mirror of the repo root's ../../../config/seed.ts, for this static site to
// import directly in the browser (no bundler runs over sites/flagship/ at deploy time —
// `npm run deploy` only copies the built widget bundle in, per package.json). Kept
// byte-parallel to the TypeScript source on purpose: the Worker enforces every real tool
// call against config/seed.ts, this file only drives what the page itself renders, and
// the two must never disagree. If seed.ts changes, mirror the change here too.
const DAY = 86_400_000;

export const USER = { name: 'Alex Rivera', email: 'alex@example.com', tier: 'standard', since: '2023-04-11' };

export const PRODUCTS = [
  { sku: 'SKU-STD-001', title: 'Halden Portable Lamp — Linen Blue', price: 9900, finalSale: false,
    description: 'Dimmable portable lamp with an opal-glass shade, linen-blue frame, and ash handle.' },
  { sku: 'SKU-STD-002', title: 'Halden Portable Lamp — Ivory', price: 9900, finalSale: false,
    description: 'The same rechargeable portable lamp in a warm ivory finish.' },
  { sku: 'SKU-CLR-114', title: 'Orbit Wall Sconce (clearance)', price: 4500, finalSale: true,
    description: 'Opal-glass globe cradled by an oval brushed-brass frame. Final sale.' },
  { sku: 'SKU-CLR-207', title: 'Pell Floor Lamp (clearance)', price: 12900, finalSale: true,
    description: 'Travertine base, curved brass stem, and an opal-glass shade. Final sale.' },
];

export function seedOrders(now) {
  return [
    { orderId: 'ORD-1043', placedAt: now - 40 * DAY, deliveredAt: now - 35 * DAY, status: 'delivered',
      items: [{ itemId: 'IT-1', sku: 'SKU-STD-001', title: 'Halden Portable Lamp — Linen Blue', price: 9900 }] },
    { orderId: 'ORD-1102', placedAt: now - 6 * DAY, deliveredAt: now - 4 * DAY, status: 'delivered',
      items: [{ itemId: 'IT-2', sku: 'SKU-CLR-114', title: 'Orbit Wall Sconce (clearance)', price: 4500 }] },
    { orderId: 'ORD-1118', placedAt: now - 2 * DAY, deliveredAt: null, status: 'in_transit',
      items: [{ itemId: 'IT-3', sku: 'SKU-STD-002', title: 'Halden Portable Lamp — Ivory', price: 9900 }] },
  ];
}
