// Headless analysis for development: node dist/cli.js <folder> [--json out.json]
import * as fs from 'fs';
import * as path from 'path';
import { analyzeProject } from './analysis/analyzer';
import { TYPE_KINDS } from './model/types';

(async () => {
  const root = path.resolve(process.argv[2] ?? '.');
  const jsonOut = process.argv.indexOf('--json') > 0 ? process.argv[process.argv.indexOf('--json') + 1] : undefined;
  const { model, parsed, graph } = await analyzeProject(root, {
    exclude: ['**/node_modules/**', '**/.git/**', '**/Library/**', '**/Temp/**', '**/obj/**', '**/bin/**', '**/Logs/**', '**/PackageCache/**', '**/dist/**', '**/out/**', '**/*.d.ts', '**/*.min.js'],
    maxFiles: 50000,
    smells: { godObjectDependencies: 12, godObjectMethods: 30, couplingThreshold: 8 },
  });
  const s = model.stats;
  console.log(`${model.project.name}: ${s.sourceFiles} source files, ${s.types} types, ${s.methods} methods, ${s.relationships} relationships — ${model.durationMs} ms`);
  console.log(`frameworks: ${model.project.frameworks.join(', ') || '-'}`);
  console.log(`modules (${model.modules.length}): ${model.modules.map((m) => `${m.name}[${m.layer ?? '?'}:${m.symbols.length}]`).join(', ')}`);
  console.log(`layers: ${model.layers.map((l) => `${l.name}(${l.symbols})`).join(' → ')}`);
  console.log(`patterns: ${model.patterns.map((p) => `${p.name} ${Math.round(p.confidence * 100)}%`).join(', ')}`);
  const byType = model.relationships.reduce<Record<string, number>>((a, r) => ((a[r.type] = (a[r.type] ?? 0) + 1), a), {});
  console.log(`relationships: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`DI: ${model.di.containers.join(', ') || 'none'} · ${model.di.registrations.length} registrations · ${model.di.injections.length} injections`);
  const fk = model.findings.reduce<Record<string, number>>((a, f) => ((a[f.kind] = (a[f.kind] ?? 0) + 1), a), {});
  console.log(`findings: ${Object.entries(fk).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const errs = parsed.filter((p) => p.errors?.length);
  console.log(`parse errors: ${errs.length}${errs.length ? ' — ' + errs.slice(0, 5).map((e) => `${e.file}: ${e.errors![0]}`).join(' | ') : ''}`);
  // Sanity: types whose recorded range is suspicious (end < start) indicate brace-matching problems.
  const bad = model.symbols.filter((x) => x.endLine < x.startLine);
  console.log(`suspicious ranges: ${bad.length}`);
  const types = model.symbols.filter((x) => TYPE_KINDS.has(x.kind));
  const isolated = types.filter((t) => graph.dependencies(t.id).length === 0 && graph.dependents(t.id).length === 0).length;
  console.log(`isolated types: ${isolated}/${types.length}`);
  const hubs = types.map((t) => ({ t, n: graph.dependents(t.id).length })).sort((a, b) => b.n - a.n).slice(0, 8);
  console.log(`hubs: ${hubs.map((h) => `${h.t.name}(${h.n})`).join(', ')}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(model, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
