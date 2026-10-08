import * as fs from 'fs';
import * as path from 'path';
import { ArchitectureModel, Finding, MODEL_VERSION, ParsedFile } from '../model/types';
import { scanProject, ScanOptions } from '../scanner/projectScanner';
import { parseCSharp } from '../parsers/csharpParser';
import { parseTypeScript } from '../parsers/typescriptParser';
import { resolve } from './resolver';
import { assignModuleLayers, detectModules, detectPatterns, inferLayers } from './architecture';
import { GraphIndex } from './graph';
import { detectSmells, SmellOptions } from './smells';
import { checkRules, parseRules, RULES_FILE_NAMES } from './rules';

export const PARSER_VERSION = 4; // bump to invalidate caches when parser output changes

export interface AnalyzeOptions extends ScanOptions {
  smells: SmellOptions;
  /** Previously parsed files keyed by path; reused when the content hash is unchanged. */
  cache?: Map<string, ParsedFile>;
  onProgress?: (message: string, fraction: number) => void;
  isCancelled?: () => boolean;
}

export interface AnalyzeResult {
  model: ArchitectureModel;
  parsed: ParsedFile[];
  graph: GraphIndex;
  rulesError?: string;
}

const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

export async function analyzeProject(root: string, opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const t0 = Date.now();
  opts.onProgress?.('Discovering files…', 0);
  const scan = scanProject(root, opts);
  await yieldToEventLoop();

  // ---- Parse (incremental)
  const parsed: ParsedFile[] = [];
  let parsedCount = 0;
  let cachedCount = 0;
  const total = scan.sourceFiles.length;
  for (let i = 0; i < total; i++) {
    if (opts.isCancelled?.()) throw new Error('Analysis cancelled');
    const f = scan.sourceFiles[i];
    const cached = opts.cache?.get(f.rel);
    if (cached && cached.hash === f.hash) {
      parsed.push(cached);
      cachedCount++;
      continue;
    }
    let src: string;
    try {
      src = fs.readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const pf = f.language === 'csharp' ? parseCSharp(f.rel, src, f.hash) : parseTypeScript(f.rel, src, f.hash, f.language);
    parsed.push(pf);
    parsedCount++;
    if (parsedCount % 40 === 0) {
      opts.onProgress?.(`Parsing ${f.rel}`, 0.05 + 0.65 * (i / Math.max(1, total)));
      await yieldToEventLoop();
    }
  }

  opts.onProgress?.('Resolving references…', 0.72);
  await yieldToEventLoop();
  const resolved = resolve(parsed);

  opts.onProgress?.('Detecting modules and layers…', 0.82);
  await yieldToEventLoop();
  const sourcePaths = scan.sourceFiles.map((f) => f.rel);
  const modules = detectModules(resolved.symbols, resolved.relationships, sourcePaths);
  const layers = inferLayers(resolved.symbols, resolved.relationships);
  assignModuleLayers(modules, resolved.symbols);
  const patterns = detectPatterns(resolved.symbols, resolved.relationships, resolved.di, scan.project.frameworks, sourcePaths);

  const model: ArchitectureModel = {
    version: MODEL_VERSION,
    analyzedAt: new Date().toISOString(),
    durationMs: 0,
    project: scan.project,
    files: scan.files,
    symbols: resolved.symbols,
    relationships: resolved.relationships,
    modules,
    layers,
    patterns,
    findings: [],
    di: resolved.di,
    stats: {
      files: scan.files.length,
      sourceFiles: total,
      types: resolved.symbols.filter((s) => ['class', 'interface', 'struct', 'enum', 'record', 'type'].includes(s.kind)).length,
      methods: resolved.symbols.filter((s) => s.kind === 'method' || s.kind === 'function' || s.kind === 'constructor').length,
      relationships: resolved.relationships.length,
      parsedFiles: parsedCount,
      cachedFiles: cachedCount,
    },
  };

  opts.onProgress?.('Detecting architecture smells…', 0.9);
  await yieldToEventLoop();
  const graph = new GraphIndex(model);
  const findings: Finding[] = detectSmells(graph, modules, parsed, resolved.di, opts.smells);
  let rulesError: string | undefined;
  for (const name of RULES_FILE_NAMES) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    const { rules, error } = parseRules(fs.readFileSync(p, 'utf8'));
    rulesError = error;
    findings.push(...checkRules(rules, graph));
    break;
  }
  const sevOrder = { error: 0, warning: 1, info: 2 };
  model.findings = findings.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  model.durationMs = Date.now() - t0;
  opts.onProgress?.('Done', 1);
  return { model, parsed, graph, rulesError };
}
