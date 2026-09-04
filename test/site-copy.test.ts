import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const home = read('site/index.html');
const secondaryPages = [
  read('site/install.html'),
  read('site/conventions.html'),
  read('site/gap.html'),
  read('site/for-agents.html'),
];
const demoBar = read('site/demo-bar.js');
const llms = read('site/llms.txt');
const demoPages = [
  read('sites/flagship/index.html'),
  read('sites/clinic/index.html'),
];

const hrefsIn = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

describe('public site structure', () => {
  it('keeps the judge-first homepage navigation on stable public routes', () => {
    const nav = home.match(/<nav>([\s\S]*?)<\/nav>/)?.[1] ?? '';

    // The two demos sit behind one Demos disclosure in the masthead, so both live
    // routes are reachable from every page's nav without a detour through the homepage.
    expect(hrefsIn(nav)).toEqual([
      '#model',
      './demo/halden/',
      './demo/clinic/',
      '#watch',
      './install',
      './conventions',
      'https://github.com/juanpatti/3way',
    ]);
    expect(nav).toMatch(/<button[^>]*class="nav-demos__btn"[^>]*aria-expanded="false"/);
    expect(hrefsIn(home)).toEqual(expect.arrayContaining([
      './demo/halden/',
      './demo/clinic/',
    ]));
  });

  it('presents the required homepage sections in order without demo-specific detours', () => {
    const sectionIds = [...home.matchAll(/<section\b[^>]*\bid="([^"]+)"/g)]
      .map((match) => match[1]);

    expect(sectionIds).toEqual([
      'watch',
      'model',
      'webmcp',
      'coordination',
      'modes',
      'evidence',
      'implementation',
      'limits',
    ]);
  });

  it('keeps secondary pages connected to the stable public routes', () => {
    for (const page of [home, ...secondaryPages]) {
      expect(page).toContain('class="nav-demos__btn"');
      expect(page).toContain('src="./assets/nav.js"');
    }
    for (const page of secondaryPages) {
      expect(hrefsIn(page)).toEqual(expect.arrayContaining([
        './',
        './install',
        './conventions',
        './gap',
        './demo/halden/',
        './demo/clinic/',
      ]));
    }
  });

  // A visiting agent with no WebMCP consumer in its runtime — measured on Chrome 152 with
  // an agent extension — drives the page as the person unless something tells it there is
  // a declared channel and how to reach it. Three signals, each pinned: the prompt the
  // person gives it, the light-DOM line and recipe the demo bar renders, and llms.txt.
  it('tells a visiting agent to prefer the declared channel, in the prompt and on the page', () => {
    for (const page of demoPages) {
      const prompts = JSON.parse(page.match(/data-prompts='([^']*)'/)![1]) as Array<{ text: string }>;
      for (const prompt of prompts) expect(prompt.text).toMatch(/WebMCP/);
    }
    expect(demoBar).toContain('document.modelContext');
    expect(demoBar).toContain('getTools()');
    expect(demoBar).toContain('executeTool(tool, JSON.stringify(');
    expect(demoBar).toContain('https://3way.dev/for-agents');
    expect(llms).toContain('document.modelContext');
    expect(llms).toContain('https://3way.dev/demo/halden/');
    expect(llms).toContain('https://3way.dev/demo/clinic/');
  });

  it('embeds the demo film from Cloudflare Stream on the homepage', () => {
    expect(home).toMatch(/<iframe[^>]*src="https:\/\/customer-e7p1u7jjz270jijp\.cloudflarestream\.com\/2a4f6087afaa35a191f43f2d79befcbc\/iframe[^"]*"/);
    expect(home).toMatch(/<iframe[^>]*\btitle="[^"]+"/);
  });

  it('carries the Keyholder tagline in the demo bar', () => {
    expect(demoBar).toContain('Two agents talk in the open. You hold the key.');
  });

  it('runs the lamp store in Keyholder mode and the clinic in Composer mode', () => {
    const [flagship, clinic] = demoPages;
    expect(flagship).toContain('data-3way-input="keyholder"');
    expect(clinic).toContain('data-3way-input="composer"');
  });

  it('documents the mode attribute an embedder uses to opt back into Composer', () => {
    expect(read('site/install.html')).toContain('data-3way-input');
  });

  it('publishes parseable demo prompts with the documented fields', () => {
    for (const page of demoPages) {
      const encoded = page.match(/data-prompts='([^']*)'/)?.[1];
      expect(encoded).toBeDefined();

      const prompts: unknown = JSON.parse(encoded!);
      expect(prompts).toHaveLength(3);
      for (const prompt of prompts as Array<Record<string, unknown>>) {
        expect(Object.keys(prompt).sort()).toEqual(['label', 'shows', 'text']);
        expect(prompt).toEqual({
          label: expect.any(String),
          shows: expect.any(String),
          text: expect.any(String),
        });
      }
    }
  });
});
