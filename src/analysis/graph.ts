import { ArchitectureModel, CALLABLE_KINDS, ModuleInfo, Relationship, RelationshipType, SymbolInfo, TYPE_KINDS } from '../model/types';

/** Relationship types that represent a type-level dependency of source on target. */
export const DEPENDENCY_TYPES: ReadonlySet<RelationshipType> = new Set([
  'depends_on', 'references', 'creates', 'inherits', 'implements', 'injects', 'subscribes_to', 'publishes',
]);

export interface CallTreeNode {
  symbol: SymbolInfo;
  rel?: Relationship;
  children: CallTreeNode[];
  truncated?: boolean;
}

export interface ImpactReport {
  target: SymbolInfo[];
  direct: { symbol: SymbolInfo; via: RelationshipType[] }[];
  indirect: { symbol: SymbolInfo; distance: number }[];
  modulesAffected: { module: ModuleInfo; count: number }[];
  diRegistrations: number;
  injectionSites: number;
  eventSubscriptions: number;
  callSites: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  score: number;
  reasons: string[];
}

export interface SearchHit {
  kind: 'symbol' | 'file' | 'module';
  id: string;
  label: string;
  detail: string;
  score: number;
  symbol?: SymbolInfo;
  module?: ModuleInfo;
}

export class GraphIndex {
  readonly byId = new Map<string, SymbolInfo>();
  readonly out = new Map<string, Relationship[]>();
  readonly in = new Map<string, Relationship[]>();
  readonly children = new Map<string, SymbolInfo[]>();
  readonly symbolsByFile = new Map<string, SymbolInfo[]>();
  readonly moduleById = new Map<string, ModuleInfo>();

  constructor(readonly model: ArchitectureModel) {
    for (const s of model.symbols) {
      this.byId.set(s.id, s);
      const arr = this.symbolsByFile.get(s.file);
      if (arr) arr.push(s);
      else this.symbolsByFile.set(s.file, [s]);
    }
    for (const r of model.relationships) {
      push(this.out, r.source, r);
      push(this.in, r.target, r);
      if (r.type === 'contains') {
        const c = this.byId.get(r.target);
        if (c) push(this.children, r.source, c);
      }
    }
    for (const m of model.modules) this.moduleById.set(m.id, m);
  }

  get(id: string): SymbolInfo | undefined {
    return this.byId.get(id);
  }

  ownerType(s: SymbolInfo): SymbolInfo {
    let cur: SymbolInfo | undefined = s;
    while (cur && !TYPE_KINDS.has(cur.kind) && cur.parent) cur = this.byId.get(cur.parent);
    return cur ?? s;
  }

  /** Types and top-level functions/variables (graph level 2). */
  isTopLevel(s: SymbolInfo): boolean {
    return TYPE_KINDS.has(s.kind) || !s.parent;
  }

  outgoing(id: string, types?: ReadonlySet<RelationshipType>): Relationship[] {
    const rs = this.out.get(id) ?? [];
    return types ? rs.filter((r) => types.has(r.type)) : rs;
  }

  incoming(id: string, types?: ReadonlySet<RelationshipType>): Relationship[] {
    const rs = this.in.get(id) ?? [];
    return types ? rs.filter((r) => types.has(r.type)) : rs;
  }

  /** All members (recursively) of a type, including itself. */
  selfAndMembers(id: string): SymbolInfo[] {
    const res: SymbolInfo[] = [];
    const s = this.byId.get(id);
    if (!s) return res;
    const stack = [s];
    while (stack.length) {
      const cur = stack.pop()!;
      res.push(cur);
      for (const c of this.children.get(cur.id) ?? []) stack.push(c);
    }
    return res;
  }

  dependencies(id: string): { symbol: SymbolInfo; types: RelationshipType[]; rels: Relationship[] }[] {
    return this.groupByOther(this.outgoing(id, DEPENDENCY_TYPES), 'target');
  }

  dependents(id: string): { symbol: SymbolInfo; types: RelationshipType[]; rels: Relationship[] }[] {
    // dependents of a type = incoming type-level edges + callers into any of its members, lifted to their owner types
    const rels: Relationship[] = [...this.incoming(id, DEPENDENCY_TYPES)];
    for (const m of this.selfAndMembers(id)) {
      if (m.id === id) continue;
      for (const r of this.incoming(m.id)) if (r.type === 'calls' || r.type === 'subscribes_to' || r.type === 'publishes') rels.push(r);
    }
    const lifted = rels.map((r) => {
      const src = this.byId.get(r.source);
      const owner = src ? this.ownerType(src) : undefined;
      return owner && owner.id !== id ? { ...r, source: owner.id } : undefined;
    }).filter((r): r is Relationship => !!r);
    return this.groupByOther(lifted, 'source');
  }

  private groupByOther(rels: Relationship[], side: 'source' | 'target'): { symbol: SymbolInfo; types: RelationshipType[]; rels: Relationship[] }[] {
    const m = new Map<string, { symbol: SymbolInfo; types: Set<RelationshipType>; rels: Relationship[] }>();
    for (const r of rels) {
      const other = this.byId.get(r[side]);
      if (!other) continue;
      let e = m.get(other.id);
      if (!e) m.set(other.id, (e = { symbol: other, types: new Set(), rels: [] }));
      e.types.add(r.type);
      e.rels.push(r);
    }
    return [...m.values()].map((e) => ({ symbol: e.symbol, types: [...e.types], rels: e.rels })).sort((a, b) => a.symbol.name.localeCompare(b.symbol.name));
  }

  callers(id: string): Relationship[] {
    return this.incoming(id).filter((r) => r.type === 'calls');
  }

  callees(id: string): Relationship[] {
    return this.outgoing(id).filter((r) => r.type === 'calls');
  }

  callTree(id: string, direction: 'callers' | 'callees', depth: number): CallTreeNode | undefined {
    const root = this.byId.get(id);
    if (!root) return undefined;
    const visited = new Set<string>([id]);
    const build = (s: SymbolInfo, rel: Relationship | undefined, d: number): CallTreeNode => {
      const node: CallTreeNode = { symbol: s, rel, children: [] };
      if (d >= depth) {
        node.truncated = (direction === 'callers' ? this.callers(s.id) : this.callees(s.id)).length > 0;
        return node;
      }
      for (const r of direction === 'callers' ? this.callers(s.id) : this.callees(s.id)) {
        const otherId = direction === 'callers' ? r.source : r.target;
        const other = this.byId.get(otherId);
        if (!other || visited.has(otherId)) continue;
        visited.add(otherId);
        node.children.push(build(other, r, d + 1));
      }
      return node;
    };
    // a type: aggregate its members
    if (TYPE_KINDS.has(root.kind)) {
      const node: CallTreeNode = { symbol: root, children: [] };
      for (const m of this.children.get(id) ?? []) {
        if (!CALLABLE_KINDS.has(m.kind) && m.kind !== 'property') continue;
        visited.add(m.id);
        const sub = build(m, undefined, 0);
        if (sub.children.length) node.children.push(sub);
      }
      return node;
    }
    return build(root, undefined, 0);
  }

  /** Shortest path between two symbols over dependency + call edges (type-lifted). */
  findPath(fromId: string, toId: string, maxDepth = 8): SymbolInfo[] | undefined {
    const prev = new Map<string, string>();
    const q = [fromId];
    const seen = new Set([fromId]);
    let depth = 0;
    while (q.length && depth <= maxDepth) {
      const next: string[] = [];
      for (const cur of q) {
        if (cur === toId) {
          const path: SymbolInfo[] = [];
          for (let c: string | undefined = cur; c; c = prev.get(c)) path.unshift(this.byId.get(c)!);
          return path;
        }
        for (const r of this.outgoing(cur)) {
          if (r.type === 'contains' || seen.has(r.target)) continue;
          seen.add(r.target);
          prev.set(r.target, cur);
          next.push(r.target);
        }
      }
      q.splice(0, q.length, ...next);
      depth++;
    }
    return undefined;
  }

  impact(ids: string[], maxDepth = 4): ImpactReport {
    const targets = ids.map((i) => this.byId.get(i)).filter((s): s is SymbolInfo => !!s);
    const targetTypes = new Set(targets.map((t) => this.ownerType(t).id));
    const direct = new Map<string, { symbol: SymbolInfo; via: Set<RelationshipType> }>();
    let callSites = 0;
    let eventSubscriptions = 0;
    for (const tid of targetTypes) {
      for (const d of this.dependents(tid)) {
        if (targetTypes.has(d.symbol.id)) continue;
        let e = direct.get(d.symbol.id);
        if (!e) direct.set(d.symbol.id, (e = { symbol: d.symbol, via: new Set() }));
        for (const t of d.types) e.via.add(t);
        callSites += d.rels.filter((r) => r.type === 'calls').length;
        eventSubscriptions += d.rels.filter((r) => r.type === 'subscribes_to').length;
      }
      // implementations of an interface are affected by contract changes
      const t = this.byId.get(tid);
      if (t?.kind === 'interface') {
        for (const r of this.incoming(tid)) if (r.type === 'implements') {
          const s = this.byId.get(r.source);
          if (s && !direct.has(s.id)) direct.set(s.id, { symbol: s, via: new Set(['implements']) });
        }
      }
    }
    const distance = new Map<string, number>();
    let frontier = [...direct.keys()];
    for (const f of frontier) distance.set(f, 1);
    for (let d = 2; d <= maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const dep of this.dependents(f)) {
          const id = dep.symbol.id;
          if (targetTypes.has(id) || distance.has(id)) continue;
          // only follow strong edges transitively (not mere event subscriptions)
          if (!dep.types.some((t) => t !== 'subscribes_to' && t !== 'publishes')) continue;
          distance.set(id, d);
          next.push(id);
        }
      }
      frontier = next;
    }
    const indirect = [...distance].filter(([, d]) => d > 1).map(([id, d]) => ({ symbol: this.byId.get(id)!, distance: d })).sort((a, b) => a.distance - b.distance);
    const modCount = new Map<string, number>();
    for (const id of distance.keys()) {
      const m = this.byId.get(id)?.module;
      if (m) modCount.set(m, (modCount.get(m) ?? 0) + 1);
    }
    for (const t of targets) if (t.module) modCount.set(t.module, (modCount.get(t.module) ?? 0) + 1);
    const modulesAffected = [...modCount].map(([id, count]) => ({ module: this.moduleById.get(id)!, count })).filter((m) => m.module).sort((a, b) => b.count - a.count);

    const diRegistrations = this.model.di.registrations.filter((r) => (r.implementationId && targetTypes.has(r.implementationId)) || (r.serviceId && targetTypes.has(r.serviceId))).length;
    const injectionSites = this.model.di.injections.filter((i) => i.typeId && targetTypes.has(i.typeId)).length;

    const score = direct.size * 3 + indirect.length + modulesAffected.length * 4 + diRegistrations * 2 + injectionSites * 2 + eventSubscriptions * 2 + Math.min(callSites, 30) * 0.5;
    const risk = score >= 40 ? 'HIGH' : score >= 12 ? 'MEDIUM' : 'LOW';
    const reasons: string[] = [];
    if (direct.size) reasons.push(`${direct.size} direct dependent type${direct.size === 1 ? '' : 's'}`);
    if (callSites) reasons.push(`${callSites} call site${callSites === 1 ? '' : 's'} into its members`);
    if (indirect.length) reasons.push(`${indirect.length} indirect dependent${indirect.length === 1 ? '' : 's'} (up to ${maxDepth} hops)`);
    if (modulesAffected.length) reasons.push(`${modulesAffected.length} module${modulesAffected.length === 1 ? '' : 's'} affected`);
    if (diRegistrations) reasons.push(`${diRegistrations} DI registration${diRegistrations === 1 ? '' : 's'}`);
    if (injectionSites) reasons.push(`${injectionSites} injection site${injectionSites === 1 ? '' : 's'}`);
    if (eventSubscriptions) reasons.push(`${eventSubscriptions} event subscription${eventSubscriptions === 1 ? '' : 's'}`);
    if (!reasons.length) reasons.push('No dependents found in the analyzed code');

    return {
      target: targets,
      direct: [...direct.values()].map((d) => ({ symbol: d.symbol, via: [...d.via] })).sort((a, b) => a.symbol.name.localeCompare(b.symbol.name)),
      indirect,
      modulesAffected,
      diRegistrations,
      injectionSites,
      eventSubscriptions,
      callSites,
      risk,
      score: Math.round(score),
      reasons,
    };
  }

  /** Strongly connected components (size >= 2) over the given edges. Iterative Tarjan. */
  static sccs(nodes: string[], edges: Map<string, Set<string>>): string[][] {
    let index = 0;
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const result: string[][] = [];
    for (const start of nodes) {
      if (idx.has(start)) continue;
      const work: { v: string; it: Iterator<string> }[] = [];
      const visit = (v: string): void => {
        idx.set(v, index);
        low.set(v, index);
        index++;
        stack.push(v);
        onStack.add(v);
        work.push({ v, it: (edges.get(v) ?? new Set<string>()).values() });
      };
      visit(start);
      while (work.length) {
        const top = work[work.length - 1];
        const n = top.it.next();
        if (!n.done) {
          const w = n.value;
          if (!idx.has(w)) visit(w);
          else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
          continue;
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
        }
        if (low.get(top.v) === idx.get(top.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== top.v);
          if (comp.length > 1) result.push(comp);
        }
      }
    }
    return result;
  }

  search(query: string, limit = 60): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const words = splitWords(query);
    const hits: SearchHit[] = [];
    const scoreName = (name: string, extra = ''): number => {
      const n = name.toLowerCase();
      if (n === q) return 100;
      if (n.startsWith(q)) return 80 - Math.min(20, n.length - q.length);
      if (n.includes(q)) return 60 - Math.min(20, n.length - q.length);
      // camel-case initials: "FM" -> FarmManager
      const initials = name.replace(/[^A-Z]/g, '').toLowerCase();
      if (q.length >= 2 && initials.startsWith(q)) return 50;
      const nw = splitWords(name + ' ' + extra);
      const matched = words.filter((w) => nw.some((x) => x.startsWith(w) || w.startsWith(x)));
      return matched.length ? (matched.length / words.length) * 40 : 0;
    };
    for (const s of this.model.symbols) {
      let sc = scoreName(s.name, s.kind === 'method' ? '' : s.file);
      if (!sc) continue;
      if (TYPE_KINDS.has(s.kind)) sc += 8;
      if (s.kind === 'field' || s.kind === 'variable') sc -= 10;
      hits.push({ kind: 'symbol', id: s.id, label: s.name, detail: `${s.kind} · ${s.file}:${s.startLine}`, score: sc, symbol: s });
    }
    for (const m of this.model.modules) {
      const sc = scoreName(m.name, m.path);
      if (sc) hits.push({ kind: 'module', id: m.id, label: m.name, detail: `module · ${m.files.length} files · ${m.layer ?? ''}`, score: sc + 10, module: m });
    }
    for (const f of this.model.files) {
      if (f.type !== 'source' && f.type !== 'configuration' && f.type !== 'dependency-config') continue;
      const base = f.path.slice(f.path.lastIndexOf('/') + 1);
      const sc = scoreName(base, f.path);
      if (sc >= 40) hits.push({ kind: 'file', id: f.path, label: base, detail: f.path, score: sc - 5 });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map(stem);
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'how', 'does', 'do', 'what', 'where', 'when', 'why', 'which', 'who', 'work', 'works', 'happen', 'happens', 'it', 'this', 'that', 'for', 'on', 'with', 'from', 'by', 'me', 'show', 'flow', 'cs', 'ts']);

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}
