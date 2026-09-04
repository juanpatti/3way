// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PRODUCT_IMAGES = [
  {
    sku: 'SKU-STD-001',
    src: './assets/halden-portable-linen-blue.webp',
    alt: 'Halden Portable Lamp in Linen Blue.',
  },
  {
    sku: 'SKU-STD-002',
    src: './assets/halden-portable-ivory.webp',
    alt: 'Halden Portable Lamp in Ivory.',
  },
  {
    sku: 'SKU-CLR-114',
    src: './assets/orbit-wall-sconce.webp',
    alt: 'Orbit Wall Sconce in brushed brass with an illuminated opal-glass shade.',
  },
  {
    sku: 'SKU-CLR-207',
    src: './assets/pell-floor-lamp.webp',
    alt: 'Pell Floor Lamp with a travertine base, brass stem, and illuminated opal-glass shade.',
  },
];

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = `
    <div id="account-pill"></div>
    <p id="orders-intro"></p>
    <div id="product-grid" data-loading="true"></div>
    <div id="order-history" data-loading="true"></div>
    <div id="policy-body"></div>
  `;
});

describe('Halden product photography', () => {
  it('renders the correct accessible local image for every catalogue SKU', async () => {
    await import('../sites/flagship/store.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const rendered = [...document.querySelectorAll<HTMLElement>('.product-card')].map(card => {
      const image = card.querySelector<HTMLImageElement>('.product-card__image');
      return {
        sku: card.dataset.sku,
        src: image?.getAttribute('src'),
        alt: image?.getAttribute('alt'),
      };
    });

    expect(rendered).toEqual(PRODUCT_IMAGES);
    for (const image of PRODUCT_IMAGES) {
      expect(existsSync(resolve('sites/flagship', image.src))).toBe(true);
    }
  });

  it('uses the Linen Blue product photograph as accessible hero art', () => {
    const html = readFileSync('sites/flagship/index.html', 'utf8');
    const page = new DOMParser().parseFromString(html, 'text/html');
    const hero = page.querySelector('.hero__art');
    const image = hero?.querySelector<HTMLImageElement>('.hero__image');

    expect(image?.getAttribute('src')).toBe('./assets/halden-hero-linen-blue.webp');
    expect(image?.getAttribute('alt')).toBe('Halden Portable Lamp in Linen Blue with its opal-glass diffuser illuminated.');
    expect(image?.getAttribute('width')).toBe('1024');
    expect(image?.getAttribute('height')).toBe('1536');
    expect(hero?.querySelector('svg')).toBeNull();
    expect(existsSync(resolve('sites/flagship/assets/halden-hero-linen-blue.webp'))).toBe(true);
  });
});
