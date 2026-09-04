#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const [sourceRoot, destinationRoot] = process.argv.slice(2);
if (!sourceRoot || !destinationRoot) {
  throw new Error('usage: version-demo-assets.mjs <source-demo-dir> <built-demo-dir>');
}

const localAsset = /(\.\/[A-Za-z0-9_./-]+\.(?:css|js|mjs|webp|png|jpe?g|svg|woff2?))(?:\?v=[a-f0-9]+)?/g;
const versionOf = path => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 10);

function sourceScripts(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return sourceScripts(child);
    return entry.isFile() && entry.name.endsWith('.js') ? [child] : [];
  });
}

function versionReferences(consumer) {
  const before = readFileSync(consumer, 'utf8');
  const after = before.replace(localAsset, (match, reference) => {
    const target = resolve(dirname(consumer), reference);
    return existsSync(target) ? `${reference}?v=${versionOf(target)}` : match;
  });
  if (after !== before) writeFileSync(consumer, after);
}

// Version dependencies before their consumers. That makes a store.js URL change when
// either store.js itself changes or one of its imported config/image URLs changes.
const scripts = sourceScripts(sourceRoot)
  .map(source => join(destinationRoot, relative(sourceRoot, source)))
  .sort((left, right) => right.split('/').length - left.split('/').length);

for (const script of scripts) versionReferences(script);
versionReferences(join(destinationRoot, 'index.html'));
