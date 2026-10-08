import { DIInfo, Finding, ModuleInfo, ParsedFile, Relationship, SymbolInfo, TYPE_KINDS, CALLABLE_KINDS } from '../model/types';
import { GraphIndex } from './graph';
import { layerRank } from './architecture';
import { similarity } from '../parsers/fingerprint';

export interface SmellOptions {
  godObjectDependencies: number;
  godObjectMethods: number;
  couplingThreshold: number;
}

const STRUCTURAL = new Set(['depends_on', 'references', 'creates', 'injects']);

/** Unity / framework callbacks that are invoked by the engine, never by project code. */
const FRAMEWORK_CALLBACKS = new Set([
  'Awake', 'Start', 'Update', 'FixedUpdate', 'LateUpdate', 'OnEnable', 'OnDisable', 'OnDestroy', 'OnValidate', 'Reset', 'OnGUI',
  'OnTriggerEnter', 'OnTriggerExit', 'OnTriggerStay', 'OnCollisionEnter', 'OnCollisionExit', 'OnCollisionStay', 'OnTriggerEnter2D',
  'OnTriggerExit2D', 'OnCollisionEnter2D', 'OnCollisionExit2D', 'OnMouseDown', 'OnMouseUp', 'OnMouseEnter', 'OnMouseExit',
  'OnPointerClick', 'OnPointerDown', 'OnPointerUp', 'OnPointerEnter', 'OnPointerExit', 'OnBeginDrag', 'OnDrag', 'OnEndDrag', 'OnDrop',
  'OnApplicationPause', 'OnApplicationFocus', 'OnApplicationQuit', 'OnBecameVisible', 'OnBecameInvisible', 'OnDrawGizmos',
  'OnDrawGizmosSelected', 'OnAnimatorMove', 'OnRectTransformDimensionsChange', 'Configure', 'Initialize', 'Tick', 'PostInitialize',
  'FixedTick', 'LateTick', 'PostStart', 'StartAsync', 'Dispose', 'Main', 'onLoad', 'onEnable', 'onDisable', 'onDestroy', 'start', 'update',
  'lateUpdate', 'render', 'ngOnInit', 'ngOnDestroy', 'componentDidMount', 'componentWillUnmount', 'constructor', 'InstallBindings',
]);

export function detectSmells(graph: GraphIndex, modules: ModuleInfo[], parsed: ParsedFile[], di: DIInfo, opts: SmellOptions): Finding[] {
  const findings: Finding[] = [];
  const symbols = graph.model.symbols;
  const types = symbols.filter((s) => TYPE_KINDS.has(s.kind) && s.kind !== 'enum' && s.kind !== 'type');
  const thirdParty = (s: SymbolInfo): boolean => /(^|\/)(Plugins|ThirdParty|Third-Party|External|Vendor)(\/|$)/i.test(s.file);

  // ---- God object & excessive coupling
  for (const t of types) {
    if (thirdParty(t) || t.kind === 'interface') continue;
    const deps = new Set(graph.outgoing(t.id).filter((r) => STRUCTURAL.has(r.type)).map((r) => r.target));
    const members = graph.children.get(t.id) ?? [];
    const methods = members.filter((m) => m.kind === 'method').length;
    const lines = t.endLine - t.startLine + 1;
    const depModules = new Set([...deps].map((d) => graph.get(d)?.module).filter(Boolean));
    const responsibilities = Math.max(depModules.size, 1);
    const god = deps.size >= opts.godObjectDependencies || methods >= opts.godObjectMethods || (lines >= 1200 && methods >= 15);
    if (god) {
      findings.push({
        kind: 'god-object',
        severity: deps.size >= opts.godObjectDependencies * 1.5 || methods >= opts.godObjectMethods * 1.5 ? 'error' : 'warning',
        title: `Possible God Object: ${t.name}`,
        detail: `Dependencies: ${deps.size} · Methods: ${methods} · Lines: ${lines} · Touches ${responsibilities} module${responsibilities === 1 ? '' : 's'}`,
        symbols: [t.id],
        location: { file: t.file, line: t.startLine },
      });
    } else if (deps.size >= opts.couplingThreshold) {
      findings.push({
        kind: 'excessive-coupling',
        severity: 'warning',
        title: `Excessive coupling: ${t.name}`,
        detail: `Depends on ${deps.size} types: ${[...deps].slice(0, 8).map((d) => graph.get(d)?.name).join(', ')}${deps.size > 8 ? ', …' : ''}`,
        symbols: [t.id],
        location: { file: t.file, line: t.startLine },
      });
    }
  }

  // ---- Circular dependencies (module level, then type level)
  const modEdges = new Map<string, Set<string>>();
  for (const m of modules) modEdges.set(m.id, new Set(Object.keys(m.dependsOn)));
  for (const comp of GraphIndex.sccs(modules.map((m) => m.id), modEdges).slice(0, 20)) {
    const names = comp.map((id) => modules.find((m) => m.id === id)?.name ?? id);
    findings.push({
      kind: 'circular-dependency',
      severity: 'warning',
      title: `Module cycle: ${names.slice(0, 4).join(' ↔ ')}${names.length > 4 ? ` (+${names.length - 4})` : ''}`,
      detail: `${comp.length} modules depend on each other in a cycle: ${cyclePath(comp, modEdges).map((id) => modules.find((m) => m.id === id)?.name ?? id).join(' → ')}`,
      symbols: [],
    });
  }
  const typeEdges = new Map<string, Set<string>>();
  for (const t of types) {
    if (thirdParty(t)) continue;
    const set = new Set<string>();
    for (const r of graph.outgoing(t.id)) if (STRUCTURAL.has(r.type) && r.confidence >= 0.7) {
      const target = graph.get(r.target);
      if (target && TYPE_KINDS.has(target.kind) && target.kind !== 'interface') set.add(r.target);
    }
    typeEdges.set(t.id, set);
  }
  for (const comp of GraphIndex.sccs([...typeEdges.keys()], typeEdges).sort((a, b) => a.length - b.length).slice(0, 30)) {
    const path = cyclePath(comp, typeEdges);
    const first = graph.get(comp[0])!;
    // Disambiguate same-named types (e.g. nested GridSystem types) with their outer type / namespace
    const simple = comp.map((id) => graph.get(id)?.name);
    const nm = (id: string): string => {
      const s = graph.get(id);
      if (!s) return id;
      return simple.filter((x) => x === s.name).length > 1 ? s.qualifiedName.split('.').slice(-2).join('.') : s.name;
    };
    findings.push({
      kind: 'circular-dependency',
      severity: comp.length <= 3 ? 'warning' : 'error',
      title: `Circular dependency: ${path.slice(0, 4).map(nm).join(' → ')}${path.length > 4 ? ' → …' : ''}`,
      detail: `${comp.length} types form a dependency cycle: ${path.map(nm).join(' → ')}${comp.length > path.length - 1 ? ` (and ${comp.length - (path.length - 1)} more types tangled with it)` : ''}`,
      symbols: comp,
      location: { file: first.file, line: first.startLine },
    });
  }

  // ---- Layer violations (lower layer depends on a layer closer to the user)
  const violations = new Map<string, { from: SymbolInfo; to: SymbolInfo; rel: Relationship }>();
  for (const r of graph.model.relationships) {
    if (!STRUCTURAL.has(r.type) || r.confidence < 0.7) continue;
    const a = graph.get(r.source);
    const b = graph.get(r.target);
    if (!a || !b || !a.layer || !b.layer || a.layer === b.layer) continue;
    if (a.layer === 'Composition' || thirdParty(a)) continue;
    const ra = layerRank(a.layer)!;
    const rb = layerRank(b.layer)!;
    // Only flag dependencies *towards* presentation from deeper layers; Infrastructure → anything is also suspicious.
    if (ra > rb && (b.layer === 'UI' || b.layer === 'Controller' || (ra - rb >= 2 && b.layer !== 'Composition'))) {
      const k = `${a.id}|${b.id}`;
      if (!violations.has(k)) violations.set(k, { from: a, to: b, rel: r });
    }
  }
  for (const v of [...violations.values()].slice(0, 100)) {
    findings.push({
      kind: 'layer-violation',
      severity: v.to.layer === 'UI' ? 'warning' : 'info',
      title: `Layer violation: ${v.from.name} (${v.from.layer}) → ${v.to.name} (${v.to.layer})`,
      detail: `${v.from.layer} code should not depend on ${v.to.layer}. Relationship: ${v.rel.type}.`,
      symbols: [v.from.id, v.to.id],
      location: v.rel.location,
    });
  }

  // ---- Dead code (potentially unused)
  const registered = new Set(di.registrations.map((r) => r.implementationId).filter(Boolean));
  // Framework-instantiated types: any ancestor has a base we could not resolve (MonoBehaviour, ScriptableObject,
  // Component, ...), so the engine/framework may create it from scenes, prefabs or reflection.
  const externalAncestry = new Map<string, boolean>();
  const hasExternalAncestor = (t: SymbolInfo, depth = 0): boolean => {
    const cached = externalAncestry.get(t.id);
    if (cached !== undefined) return cached;
    if (depth > 10) return false;
    externalAncestry.set(t.id, false);
    const bases = graph.outgoing(t.id).filter((r) => r.type === 'inherits' || r.type === 'implements');
    let ext = (t.baseTypes?.length ?? 0) > bases.length;
    for (const b of bases) {
      const bs = graph.get(b.target);
      if (!ext && bs && hasExternalAncestor(bs, depth + 1)) ext = true;
    }
    externalAncestry.set(t.id, ext);
    return ext;
  };
  for (const t of types) {
    if (thirdParty(t) || t.kind === 'interface' || /test/i.test(t.file)) continue;
    if (t.attributes?.length || registered.has(t.id)) continue;
    if (hasExternalAncestor(t)) continue;
    const incoming = graph.dependents(t.id).filter((d) => d.symbol.id !== t.id);
    const nestedUse = t.parent ? true : false;
    if (incoming.length === 0 && !nestedUse && !t.exported) {
      findings.push({ kind: 'dead-code', severity: 'info', title: `Potentially unused: ${t.name}`, detail: `No references to this ${t.kind} were found in analyzed code.`, symbols: [t.id], location: { file: t.file, line: t.startLine } });
    } else if (incoming.length === 0 && t.exported && t.language !== 'csharp' && !/(^|\/)(index|main|app|extension)\.[jt]sx?$/.test(t.file)) {
      findings.push({ kind: 'dead-code', severity: 'info', title: `Potentially unused export: ${t.name}`, detail: 'Exported but never imported by analyzed code.', symbols: [t.id], location: { file: t.file, line: t.startLine } });
    }
  }
  for (const s of symbols) {
    if (s.kind !== 'method' || s.visibility !== 'private' || s.language !== 'csharp') continue;
    if (FRAMEWORK_CALLBACKS.has(s.name) || s.attributes?.length || s.modifiers?.some((m) => m === 'override' || m === 'extern' || m === 'partial')) continue;
    if (thirdParty(s) || graph.callers(s.id).length || graph.incoming(s.id).some((r) => r.type !== 'contains')) continue;
    findings.push({ kind: 'dead-code', severity: 'info', title: `Potentially unused method: ${s.qualifiedName.split('.').slice(-2).join('.')}`, detail: 'Private method with no callers found (it may still be used via reflection, SendMessage, UnityEvents or animation events).', symbols: [s.id], location: { file: s.file, line: s.startLine } });
  }

  // ---- Duplicate logic (MinHash candidates via shingle buckets)
  const fps = parsed.flatMap((p) => p.methodFingerprints).filter((f) => f.tokens >= 60 && graph.get(f.id) && !thirdParty(graph.get(f.id)!));
  const buckets = new Map<number, number[]>();
  fps.forEach((f, i) => {
    for (const h of f.shingles.slice(0, 16)) {
      const b = buckets.get(h);
      if (b) {
        if (b.length < 40) b.push(i);
      } else buckets.set(h, [i]);
    }
  });
  const pairCount = new Map<string, number>();
  for (const b of buckets.values()) {
    if (b.length < 2) continue;
    for (let x = 0; x < b.length; x++) for (let y = x + 1; y < b.length; y++) {
      const k = b[x] < b[y] ? `${b[x]}|${b[y]}` : `${b[y]}|${b[x]}`;
      pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
    }
  }
  const dups: { a: SymbolInfo; b: SymbolInfo; sim: number }[] = [];
  for (const [k, c] of pairCount) {
    if (c < 6) continue;
    const [i, j] = k.split('|').map(Number);
    const a = graph.get(fps[i].id)!;
    const b = graph.get(fps[j].id)!;
    if (a.parent === b.parent && a.name === b.name) continue; // overloads
    const sim = similarity(fps[i].shingles, fps[j].shingles);
    if (sim >= 0.75) dups.push({ a, b, sim });
  }
  for (const d of dups.sort((x, y) => y.sim - x.sim).slice(0, 40)) {
    const nm = (s: SymbolInfo): string => s.qualifiedName.split('.').slice(-2).join('.');
    findings.push({
      kind: 'duplicate-logic',
      severity: d.sim >= 0.9 ? 'warning' : 'info',
      title: `Duplicate logic: ${nm(d.a)}() ≈ ${nm(d.b)}()`,
      detail: `Similarity: ${Math.round(d.sim * 100)}% (token shingles). ${d.a.file}:${d.a.startLine} vs ${d.b.file}:${d.b.startLine}`,
      symbols: [d.a.id, d.b.id],
      location: { file: d.a.file, line: d.a.startLine },
    });
  }
  void CALLABLE_KINDS;
  return findings;
}

/** A readable cycle through a strongly-connected component. */
function cyclePath(comp: string[], edges: Map<string, Set<string>>): string[] {
  const inComp = new Set(comp);
  const start = comp[0];
  const prev = new Map<string, string>();
  const q = [start];
  const seen = new Set([start]);
  while (q.length) {
    const cur = q.shift()!;
    for (const n of edges.get(cur) ?? []) {
      if (!inComp.has(n)) continue;
      if (n === start) {
        const path = [start];
        for (let c: string | undefined = cur; c && c !== start; c = prev.get(c)) path.splice(1, 0, c);
        path.push(start);
        return path;
      }
      if (!seen.has(n)) {
        seen.add(n);
        prev.set(n, cur);
        q.push(n);
      }
    }
  }
  return [...comp, start];
}
