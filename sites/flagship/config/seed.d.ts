// Type declarations for seed.js, so tsc can typecheck the mirror-drift test
// (packages/widget/test/config-mirror.test.ts) without shipping any TS build step to
// sites/flagship/ itself — a sibling .d.ts next to a .js file is resolved automatically
// by TypeScript for a relative "./seed.js" (or "../seed.js") import specifier, the same
// way a compiled package's dist/index.js pairs with dist/index.d.ts. Browsers never load
// this file. Kept in sync with config/seed.ts's shape by hand, same as seed.js itself.
import type { Order, Product } from '../../../packages/widget/src/types';

export const USER: { name: string; email: string; tier: string; since: string };
export const PRODUCTS: Product[];
export function seedOrders(now: number): Order[];
