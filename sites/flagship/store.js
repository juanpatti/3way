// Halden storefront rendering. No framework: this reads the same seed data the tools
// read (mirrored in ./config/, see the note at the top of config/seed.js) and renders
// the catalogue, order history, and policy sections directly from it, so the page can
// never say something the widget's tools would contradict.
import { PRODUCTS, USER, seedOrders } from './config/seed.js';
import { POLICY_PROSE } from './config/policy.js';

const DAY = 86_400_000;

const money = cents =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

const shortDate = ts =>
  new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric' }).format(ts);

const monthYear = isoDate =>
  new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(isoDate));

const daysAgo = (ts, now) => Math.floor((now - ts) / DAY);

const PRODUCT_IMAGES = {
  'SKU-STD-001': {
    src: './assets/halden-portable-linen-blue.webp',
    alt: 'Halden Portable Lamp in Linen Blue.',
    kind: 'studio',
  },
  'SKU-STD-002': {
    src: './assets/halden-portable-ivory.webp',
    alt: 'Halden Portable Lamp in Ivory.',
    kind: 'studio',
  },
  'SKU-CLR-114': {
    src: './assets/orbit-wall-sconce.webp',
    alt: 'Orbit Wall Sconce in brushed brass with an illuminated opal-glass shade.',
    kind: 'cutout',
  },
  'SKU-CLR-207': {
    src: './assets/pell-floor-lamp.webp',
    alt: 'Pell Floor Lamp with a travertine base, brass stem, and illuminated opal-glass shade.',
    kind: 'cutout',
  },
};

const SWATCH = { 'Linen Blue': '#8399A3', Ivory: '#E7DDCB' };
function swatchFor(title) {
  const name = title.split('—').pop()?.trim();
  return name && SWATCH[name] ? { name, color: SWATCH[name] } : null;
}

function renderProducts(products) {
  const grid = document.getElementById('product-grid');
  grid.dataset.loading = 'false';
  grid.innerHTML = products.map(p => {
    const swatch = swatchFor(p.title);
    const image = PRODUCT_IMAGES[p.sku];
    return `
      <article class="product-card" data-sku="${p.sku}">
        <div class="product-card__art">
          <img class="product-card__image product-card__image--${image.kind}"
            src="${image.src}" alt="${image.alt}" width="1024" height="1536"
            loading="lazy" decoding="async" />
        </div>
        <div class="product-card__body">
          <div class="product-card__title-row">
            <h3>${p.title}</h3>
            ${p.finalSale ? '<span class="badge badge--final">Final sale</span>' : ''}
          </div>
          <p class="product-card__desc">${p.description}</p>
          <div class="product-card__foot">
            ${swatch ? `<span class="swatch"><i style="background:${swatch.color}"></i>${swatch.name}</span>` : '<span class="swatch swatch--muted">One finish</span>'}
            <span class="price">${money(p.price)}</span>
          </div>
        </div>
      </article>`;
  }).join('');
}

const STATUS_LABEL = { delivered: 'Delivered', in_transit: 'In transit' };

function renderOrders(orders, now) {
  const panel = document.getElementById('order-history');
  panel.dataset.loading = 'false';
  panel.innerHTML = `
    <table class="orders-table">
      <thead>
        <tr><th>Order</th><th>Placed</th><th>Item</th><th>Status</th><th>Total</th></tr>
      </thead>
      <tbody>
        ${orders.map(o => {
          const total = o.items.reduce((sum, it) => sum + it.price, 0);
          const statusDetail = o.status === 'delivered'
            ? `${STATUS_LABEL[o.status]} · ${daysAgo(o.deliveredAt, now)}d ago`
            : STATUS_LABEL[o.status] ?? o.status;
          return `
            <tr data-3way-order="${o.orderId}">
              <td class="mono">${o.orderId}</td>
              <td>${shortDate(o.placedAt)}</td>
              <td>${o.items.map(it => it.title).join(', ')}</td>
              <td class="order-status"><span class="status-dot status-dot--${o.status}"></span>${statusDetail}</td>
              <td>${money(total)}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function renderPolicy(prose) {
  const lines = prose.split('\n');
  const body = lines.slice(1).join('\n').trim();
  const clauses = body.split(/\n(?=\d+\.\s)/).map(c => c.replace(/\s+/g, ' ').trim());
  const host = document.getElementById('policy-body');
  host.innerHTML = `<ol class="policy-list">${clauses.map(clause => {
    const m = clause.match(/^(\d+)\.\s+([^.]+\.)\s*(.*)$/);
    if (!m) return `<li>${clause}</li>`;
    const [, num, label, rest] = m;
    return `<li><span class="policy-num">${num.padStart(2, '0')}</span><div><strong>${label}</strong> ${rest}</div></li>`;
  }).join('')}</ol>`;
}

// The page reacts to the shared exchange: when a return the agent filed is confirmed and
// the Worker completes it, that order's row updates to show it. The widget dispatches
// 3way:action-completed on the document after the action actually ran (see index.ts).
function reflectExchangeState() {
  document.addEventListener('3way:action-completed', (event) => {
    const detail = event.detail || {};
    if (detail.tool !== 'confirm_return') return;
    const id = String(detail.orderId || '').replace(/"/g, '');
    const row = document.querySelector(`.orders-table tr[data-3way-order="${id}"]`);
    const cell = row && row.querySelector('.order-status');
    if (cell) cell.innerHTML = '<span class="status-dot status-dot--returned"></span>Return filed';
  });
}

function init() {
  const now = Date.now();
  renderProducts(PRODUCTS);
  renderOrders(seedOrders(now), now);
  reflectExchangeState();
  renderPolicy(POLICY_PROSE);
  document.getElementById('account-pill').textContent = `Signed in as ${USER.name}`;
  document.getElementById('orders-intro').textContent =
    `Signed in as ${USER.name} · member since ${monthYear(USER.since)}.`;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
