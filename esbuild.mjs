import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
if (production) rmSync('dist', { recursive: true, force: true }); // no stale source maps in the package

// The webview loads cytoscape as a local resource; copy it next to our webview scripts.
mkdirSync('media/vendor', { recursive: true });
copyFileSync('node_modules/cytoscape/dist/cytoscape.min.js', 'media/vendor/cytoscape.min.js');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
  // Headless self-test of the analysis engine (no vscode dependency).
  esbuild.context({ ...common, entryPoints: ['src/selftest.ts'], outfile: 'dist/selftest.js', external: ['vscode'] }),
  // Headless CLI: node dist/cli.js <folder>
  esbuild.context({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', external: ['vscode'] }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
