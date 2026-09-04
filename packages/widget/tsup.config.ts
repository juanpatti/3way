import { defineConfig } from 'tsup';
export default defineConfig({
  // Named entry: tsup takes the output basename from the KEY, not from the file name.
  // `entry: ['src/index.ts']` would emit dist/index.js and never dist/3way.js.
  entry: { '3way': 'src/index.ts' },
  format: ['esm', 'iife'],
  // The brand is "3way", but a JS identifier cannot start with a digit, so the IIFE
  // global is ThreeWay. Everything user-facing — package, files, docs — reads 3way.
  globalName: 'ThreeWay',
  outExtension: ({ format }) => ({ js: format === 'iife' ? '.js' : '.esm.js' }),
  // dts is emitted by tsc, not tsup: tsup 8.5.1 bundles rollup-plugin-dts built against
  // TypeScript 5.7, and TS 7 removed the internal API it calls (useCaseSensitiveFileNames).
  // tsc is the authoritative source of declarations anyway.
  dts: false,
  clean: true,
  minify: true,
});
