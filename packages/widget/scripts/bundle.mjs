// Emits dist/3way.bundle.js — the vendored WebMCP polyfill followed by the widget, so a
// site can embed with ONE script tag instead of two in a load-bearing order.
//
// A concatenation, deliberately, not a rewrite: vendor/webmcp-polyfill.js stays
// byte-for-byte what Chrome Labs published, which is the whole reason it is vendored. Its
// own guard clause makes it a no-op on any browser that already has document.modelContext,
// so putting it first costs nothing on a native surface.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const polyfill = readFileSync(join(root, 'vendor/webmcp-polyfill.js'), 'utf8');
const widget = readFileSync(join(root, 'dist/3way.js'), 'utf8');
const out = join(root, 'dist/3way.bundle.js');

writeFileSync(out, [
  '/* 3way — single-file embed. Vendored WebMCP polyfill (unmodified) + widget. */',
  polyfill,
  ';',
  widget,
].join('\n'));
console.log(`BUNDLE dist/3way.bundle.js ${(readFileSync(out).length / 1024).toFixed(2)} KB`);
