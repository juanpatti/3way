import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 10);

describe('production demo asset versioning', () => {
  it('binds every mutable stylesheet and script URL to its published bytes', () => {
    execFileSync('npm', ['run', 'site'], { stdio: 'pipe' });

    const halden = readFileSync('dist-site/demo/halden/index.html', 'utf8');
    const haldenStore = readFileSync('dist-site/demo/halden/store.js', 'utf8');
    const clinic = readFileSync('dist-site/demo/clinic/index.html', 'utf8');
    const haldenRoot = 'dist-site/demo/halden';
    const clinicRoot = 'dist-site/demo/clinic';

    expect(halden).toContain(`href="./store.css?v=${hash(`${haldenRoot}/store.css`)}"`);
    expect(halden).toContain(`src="./store.js?v=${hash(`${haldenRoot}/store.js`)}"`);
    expect(halden).toContain(`src="./assets/halden-hero-linen-blue.webp?v=${hash(`${haldenRoot}/assets/halden-hero-linen-blue.webp`)}"`);
    expect(halden).toContain(`src="./widget/3way.bundle.js?v=${hash(`${haldenRoot}/widget/3way.bundle.js`)}"`);
    expect(halden).toContain(`src="./demo-bar.js?v=${hash(`${haldenRoot}/demo-bar.js`)}"`);

    expect(haldenStore).toContain(`from './config/seed.js?v=${hash(`${haldenRoot}/config/seed.js`)}'`);
    expect(haldenStore).toContain(`from './config/policy.js?v=${hash(`${haldenRoot}/config/policy.js`)}'`);
    for (const image of [
      'halden-portable-linen-blue.webp',
      'halden-portable-ivory.webp',
      'orbit-wall-sconce.webp',
      'pell-floor-lamp.webp',
    ]) {
      expect(haldenStore).toContain(`./assets/${image}?v=${hash(`${haldenRoot}/assets/${image}`)}`);
    }

    // The root pages too: Pages caches static assets for four hours regardless of
    // _headers, so an unversioned stylesheet outlives the HTML that needs its new rules.
    for (const page of ['index', 'install', 'conventions', 'gap', 'for-agents']) {
      const html = readFileSync(`dist-site/${page}.html`, 'utf8');
      expect(html).toContain(`href="./assets/site.css?v=${hash('dist-site/assets/site.css')}"`);
      expect(html).toContain(`src="./assets/nav.js?v=${hash('dist-site/assets/nav.js')}"`);
    }

    expect(clinic).toContain(`href="./clinic.css?v=${hash(`${clinicRoot}/clinic.css`)}"`);
    expect(clinic).toContain(`src="./widget/3way.bundle.js?v=${hash(`${clinicRoot}/widget/3way.bundle.js`)}"`);
    expect(clinic).toContain(`src="./demo-bar.js?v=${hash(`${clinicRoot}/demo-bar.js`)}"`);
  });
});
