import { Relationship, SymbolInfo, TYPE_KINDS } from '../model/types';
import { DEPENDENCY_TYPES, GraphIndex, splitWords } from './graph';
import { layerRank } from './architecture';

export interface FeatureFlow {
  query: string;
  steps: { layer: string; rank: number; symbols: SymbolInfo[] }[];
  edges: { from: string; to: string; type: string; location?: Relationship['location'] }[];
  entryPoints: SymbolInfo[];
  files: string[];
  seeds: { symbol: SymbolInfo; score: number }[];
}

export function relevance(graph: GraphIndex, s: SymbolInfo, words: string[]): number {
  if (!words.length) return 0;
  const nameW = splitWords(s.name);
  const fileW = splitWords(s.file);
  let score = 0;
  for (const w of words) {
    if (nameW.some((x) => x === w)) score += 4;
    else if (nameW.some((x) => x.startsWith(w) || w.startsWith(x))) score += 2.5;
    if (fileW.some((x) => x === w)) score += 1;
  }
  let memberHits = 0;
  for (const m of graph.children.get(s.id) ?? []) {
    const mw = splitWords(m.name);
    if (words.some((w) => mw.some((x) => x === w || x.startsWith(w)))) memberHits++;
  }
  score += Math.min(memberHits, 4) * 1.2;
  return score;
}

export function traceFeature(graph: GraphIndex, query: string, maxSeeds = 8): FeatureFlow {
  const words = splitWords(query);
  const candidates = graph.model.symbols.filter((s) => TYPE_KINDS.has(s.kind) || (!s.parent && s.kind === 'function'));
  const scored = candidates
    .map((s) => ({ symbol: s, score: relevance(graph, s, words) }))
    .filter((x) => x.score >= 2.5)
    .sort((a, b) => b.score - a.score);
  const seeds = scored.slice(0, maxSeeds);
  const included = new Map<string, SymbolInfo>();
  for (const s of seeds) included.set(s.symbol.id, s.symbol);
  const scoreOf = new Map(scored.map((x) => [x.symbol.id, x.score]));

  // Expand one hop along dependencies / dependents, keeping relevant or "bridge" symbols
  for (const s of seeds) {
    for (const d of graph.dependencies(s.symbol.id)) {
      if ((scoreOf.get(d.symbol.id) ?? 0) > 0 || d.types.includes('calls') || d.types.includes('depends_on') || d.types.includes('injects')) {
        if (TYPE_KINDS.has(d.symbol.kind) && d.symbol.kind !== 'enum' && included.size < 24) included.set(d.symbol.id, d.symbol);
      }
    }
    for (const d of graph.dependents(s.symbol.id)) {
      if (included.size >= 24) break;
      if (d.symbol.layer === 'Composition') continue; // wiring, not part of the runtime flow
      const r = layerRank(d.symbol.layer);
      if ((scoreOf.get(d.symbol.id) ?? 0) > 0 || (r !== undefined && r <= 2)) included.set(d.symbol.id, d.symbol);
    }
  }
  // Walk upward from the seeds to find UI / controller entry points (up to 3 hops)
  const entryPoints: SymbolInfo[] = [];
  for (const s of seeds.slice(0, 4)) {
    let frontier = [s.symbol];
    for (let hop = 0; hop < 3 && frontier.length; hop++) {
      const next: SymbolInfo[] = [];
      for (const f of frontier) {
        for (const d of graph.dependents(f.id)) {
          const r = layerRank(d.symbol.layer);
          if (r !== undefined && r <= 2 && d.symbol.layer !== 'Composition') {
            included.set(d.symbol.id, d.symbol);
            if (!entryPoints.includes(d.symbol)) entryPoints.push(d.symbol);
          } else if (next.length < 10) next.push(d.symbol);
        }
      }
      if (entryPoints.length) break;
      frontier = next;
    }
  }

  const groups = new Map<string, { layer: string; rank: number; symbols: SymbolInfo[] }>();
  for (const s of included.values()) {
    const layer = s.layer ?? 'Other';
    const rank = layerRank(s.layer) ?? 3.5;
    let g = groups.get(layer);
    if (!g) groups.set(layer, (g = { layer, rank, symbols: [] }));
    g.symbols.push(s);
  }
  for (const g of groups.values()) g.symbols.sort((a, b) => (scoreOf.get(b.id) ?? 0) - (scoreOf.get(a.id) ?? 0));
  const steps = [...groups.values()].sort((a, b) => a.rank - b.rank);

  const edges: FeatureFlow['edges'] = [];
  const seen = new Set<string>();
  for (const s of included.values()) {
    for (const d of graph.dependencies(s.id)) {
      if (!included.has(d.symbol.id)) continue;
      const k = `${s.id}|${d.symbol.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const best = d.rels.find((r) => r.type === 'calls') ?? d.rels.find((r) => DEPENDENCY_TYPES.has(r.type)) ?? d.rels[0];
      edges.push({ from: s.id, to: d.symbol.id, type: best.type, location: best.location });
    }
    // member-level calls lifted to types
    for (const m of graph.selfAndMembers(s.id)) {
      for (const r of graph.callees(m.id)) {
        const t = graph.get(r.target);
        if (!t) continue;
        const owner = graph.ownerType(t);
        if (owner.id === s.id || !included.has(owner.id)) continue;
        const k = `${s.id}|${owner.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ from: s.id, to: owner.id, type: 'calls', location: r.location });
      }
    }
  }
  const files = [...new Set([...included.values()].map((s) => s.file))].sort();
  return { query, steps, edges, entryPoints, files, seeds };
}
