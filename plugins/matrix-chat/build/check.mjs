import { build } from 'esbuild';
// Link all renderer entry points without producing or changing shipped bundles.
await build({
  // The frames' entry files (boot, panel, the two sidebar widgets).
  entryPoints: ['boot.js', 'panel.js', 'sidebar.js', 'sidebar-account.js'],
  bundle: true,
  preserveSymlinks: true,
  tsconfigRaw: {},
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  outdir: 'build/check-output',
  write: false,
  external: ['atmos-sdk', './vendor/*', '../vendor/*'],
});
console.log('Renderer module graph checks passed');
