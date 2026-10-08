import * as fs from 'fs';
import * as path from 'path';
import { ArchitectureModel, MODEL_VERSION, ParsedFile } from '../model/types';
import { PARSER_VERSION } from '../analysis/analyzer';

/**
 * Local analysis database. JSON files in the extension's workspace storage:
 *   parse-cache.json  per-file parser output keyed by content hash (incremental analysis)
 *   model.json        the latest architecture model
 *   history.json      compact snapshots of previous analyses (architecture history)
 */
export interface HistoryEntry {
  analyzedAt: string;
  stats: ArchitectureModel['stats'];
  modules: { id: string; name: string; symbols: number; layer?: string }[];
  patterns: { name: string; confidence: number }[];
  findings: Record<string, number>;
}

export class AnalysisStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private p(name: string): string {
    return path.join(this.dir, name);
  }

  loadCache(): Map<string, ParsedFile> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.p('parse-cache.json'), 'utf8')) as { parserVersion: number; files: ParsedFile[] };
      if (raw.parserVersion !== PARSER_VERSION) return new Map();
      return new Map(raw.files.map((f) => [f.file, f]));
    } catch {
      return new Map();
    }
  }

  saveCache(files: ParsedFile[]): void {
    fs.writeFileSync(this.p('parse-cache.json'), JSON.stringify({ parserVersion: PARSER_VERSION, files }));
  }

  clearCache(): void {
    for (const f of ['parse-cache.json', 'model.json']) fs.rmSync(this.p(f), { force: true });
  }

  loadModel(): ArchitectureModel | undefined {
    try {
      const m = JSON.parse(fs.readFileSync(this.p('model.json'), 'utf8')) as ArchitectureModel;
      return m.version === MODEL_VERSION ? m : undefined;
    } catch {
      return undefined;
    }
  }

  saveModel(model: ArchitectureModel): void {
    fs.writeFileSync(this.p('model.json'), JSON.stringify(model));
    const history = this.loadHistory();
    const entry: HistoryEntry = {
      analyzedAt: model.analyzedAt,
      stats: model.stats,
      modules: model.modules.map((m) => ({ id: m.id, name: m.name, symbols: m.symbols.length, layer: m.layer })),
      patterns: model.patterns.map((p) => ({ name: p.name, confidence: p.confidence })),
      findings: model.findings.reduce<Record<string, number>>((acc, f) => ((acc[f.kind] = (acc[f.kind] ?? 0) + 1), acc), {}),
    };
    // keep one entry per hour at most, newest first, max 50
    const last = history[0];
    if (last && Date.parse(entry.analyzedAt) - Date.parse(last.analyzedAt) < 3600_000) history[0] = entry;
    else history.unshift(entry);
    fs.writeFileSync(this.p('history.json'), JSON.stringify(history.slice(0, 50)));
  }

  loadHistory(): HistoryEntry[] {
    try {
      return JSON.parse(fs.readFileSync(this.p('history.json'), 'utf8')) as HistoryEntry[];
    } catch {
      return [];
    }
  }
}
