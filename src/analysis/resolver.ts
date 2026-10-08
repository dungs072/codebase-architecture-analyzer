import * as path from 'path';
import {
  CALLABLE_KINDS, DIInfo, DIRegistration, ParsedFile, RawReference, Relationship, RelationshipType, SymbolInfo, TYPE_KINDS,
} from '../model/types';

/** Names too generic to link by name alone when the receiver type is unknown. */
const GENERIC_MEMBER_NAMES = new Set([
  'Add', 'Remove', 'Get', 'Set', 'Update', 'Init', 'Initialize', 'Start', 'Stop', 'Show', 'Hide', 'Clear', 'Reset', 'Dispose', 'ToString',
  'Equals', 'GetHashCode', 'Invoke', 'Execute', 'Run', 'Load', 'Save', 'Open', 'Close', 'Enable', 'Disable', 'Contains', 'Find', 'Create',
  'push', 'pop', 'map', 'filter', 'forEach', 'reduce', 'find', 'get', 'set', 'has', 'add', 'delete', 'clear', 'then', 'catch', 'emit',
  'on', 'off', 'once', 'subscribe', 'next', 'init', 'start', 'update', 'destroy', 'show', 'hide', 'load', 'save', 'toString', 'call',
  'apply', 'bind', 'log', 'error', 'warn', 'join', 'split', 'slice', 'splice', 'indexOf', 'includes', 'keys', 'values', 'entries',
]);

const DELEGATE_TYPE = /^(Action|Func|UnityEvent|UnityAction|EventHandler|Subject|ReactiveProperty|ReactiveCommand|IObservable|Observable|Signal|Event|EventEmitter|BehaviorSubject|ReplaySubject)/;

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

export interface ResolveOutput {
  symbols: SymbolInfo[];
  relationships: Relationship[];
  di: DIInfo;
}

export function resolve(parsed: ParsedFile[]): ResolveOutput {
  const symbols: SymbolInfo[] = [];
  const byId = new Map<string, SymbolInfo>();
  const typesByName = new Map<string, SymbolInfo[]>();
  const byQualified = new Map<string, SymbolInfo[]>();
  const members = new Map<string, SymbolInfo[]>();
  const callablesByName = new Map<string, SymbolInfo[]>();
  const topLevelByFile = new Map<string, Map<string, SymbolInfo>>();
  const parsedByFile = new Map<string, ParsedFile>();
  const filesNoExt = new Map<string, string>(); // path-without-extension -> file

  const push = <K, V>(m: Map<K, V[]>, k: K, v: V): void => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };

  for (const pf of parsed) {
    parsedByFile.set(pf.file, pf);
    filesNoExt.set(pf.file.replace(/\.(d\.ts|tsx?|mts|cts|jsx?|mjs)$/, ''), pf.file);
    for (const s of pf.symbols) {
      if (byId.has(s.id)) continue; // partial classes / duplicate declarations: keep first
      symbols.push(s);
      byId.set(s.id, s);
      const isTypeLike = TYPE_KINDS.has(s.kind) || (!s.parent && (s.kind === 'function' || s.kind === 'variable'));
      // C# partial classes split across files: index only the first declaration by name.
      const duplicatePartial = s.language === 'csharp' && s.modifiers?.includes('partial') &&
        (byQualified.get(s.qualifiedName) ?? []).some((o) => o.modifiers?.includes('partial'));
      if (isTypeLike && !duplicatePartial) {
        push(typesByName, s.name, s);
        push(byQualified, s.qualifiedName, s);
      }
      if (s.parent) push(members, s.parent, s);
      if (CALLABLE_KINDS.has(s.kind)) push(callablesByName, s.name, s);
      if (!s.parent) {
        let m = topLevelByFile.get(s.file);
        if (!m) topLevelByFile.set(s.file, (m = new Map()));
        if (!m.has(s.name)) m.set(s.name, s);
        if (s.modifiers?.includes('default')) m.set('default', s);
      }
    }
  }

  // C# partial classes in different files have different ids; unify by qualified name for member lookup.
  const partialGroups = new Map<string, SymbolInfo[]>();
  for (const s of symbols) if (s.language === 'csharp' && TYPE_KINDS.has(s.kind) && s.modifiers?.includes('partial')) push(partialGroups, s.qualifiedName, s);

  const ownerType = (s: SymbolInfo | undefined): SymbolInfo | undefined => {
    let cur = s;
    while (cur && !TYPE_KINDS.has(cur.kind) && cur.parent) cur = byId.get(cur.parent);
    return cur;
  };

  // ---------------------------------------------------------------- type resolution
  const csharpVisible = (cand: SymbolInfo, pf: ParsedFile, fromNs: string | undefined): boolean => {
    if (!cand.namespace) return true;
    if (fromNs && (fromNs === cand.namespace || fromNs.startsWith(cand.namespace + '.'))) return true;
    return pf.usings.includes(cand.namespace);
  };

  const resolveTsModule = (fromFile: string, spec: string): string | undefined => {
    if (spec.startsWith('.')) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
      for (const ext of ['', ...TS_EXTS]) {
        const candidate = (base + ext).replace(/\.(d\.ts|tsx?|mts|cts|jsx?|mjs)$/, '');
        const f = filesNoExt.get(candidate);
        if (f) return f;
      }
      const viaJs = filesNoExt.get(base.replace(/\.js$/, ''));
      return viaJs;
    }
    // Path aliases (tsconfig "paths"): "@/foo/bar", "~/foo", "src/foo"
    const stripped = spec.replace(/^(@\/|~\/|#\/|@app\/|@src\/)/, '');
    if (stripped === spec && !spec.includes('/')) return undefined; // bare package name
    for (const [noExt, f] of filesNoExt) {
      if (noExt.endsWith('/' + stripped) || noExt === stripped || noExt.endsWith('/' + stripped + '/index')) return f;
    }
    return undefined;
  };

  const cache = new Map<string, { sym?: SymbolInfo; conf: number }>();

  const resolveType = (name: string, fromSym: SymbolInfo, pf: ParsedFile): { sym?: SymbolInfo; conf: number } => {
    const key = `${pf.file}|${fromSym.namespace ?? ''}|${ownerType(fromSym)?.id ?? ''}|${name}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const r = resolveTypeUncached(name, fromSym, pf);
    cache.set(key, r);
    return r;
  };

  const resolveTypeUncached = (rawName: string, fromSym: SymbolInfo, pf: ParsedFile): { sym?: SymbolInfo; conf: number } => {
    if (rawName.startsWith('@')) return resolveChain(rawName, fromSym, pf);
    let name = rawName.replace(/^global\./, '');
    if (pf.language === 'csharp') {
      // alias usings: using Foo = Bar.Baz;
      for (const u of pf.usings) {
        const eq = u.indexOf('=');
        if (eq > 0 && (name === u.slice(0, eq) || name.startsWith(u.slice(0, eq) + '.'))) name = u.slice(eq + 1) + name.slice(eq);
      }
      if (name.includes('.')) {
        const exact = byQualified.get(name);
        if (exact?.length) return { sym: exact[0], conf: 1 };
        for (const u of pf.usings) {
          const q = byQualified.get(`${u}.${name}`);
          if (q?.length) return { sym: q[0], conf: 1 };
        }
        // nested type or partially-qualified name: match by suffix
        const last = name.slice(name.lastIndexOf('.') + 1);
        const cands = (typesByName.get(last) ?? []).filter((c) => c.qualifiedName.endsWith('.' + name) && c.language === 'csharp');
        if (cands.length) return { sym: cands[0], conf: cands.length === 1 ? 0.9 : 0.5 };
        // "Foo.Bar" where Foo is a type and Bar is a member (static access) — resolve Foo
        const head = name.slice(0, name.indexOf('.'));
        return resolveType(head, fromSym, pf);
      }
      const all = (typesByName.get(name) ?? []).filter((c) => c.language === 'csharp' && TYPE_KINDS.has(c.kind));
      if (!all.length) return { conf: 0 };
      if (all.length === 1) return { sym: all[0], conf: csharpVisible(all[0], pf, fromSym.namespace) ? 1 : 0.7 };
      // nested types of the current type / its outer types win
      const owner = ownerType(fromSym);
      for (let o = owner; o; o = o.parent ? byId.get(o.parent) : undefined) {
        const nested = all.find((c) => c.parent === o!.id);
        if (nested) return { sym: nested, conf: 1 };
      }
      const visible = all.filter((c) => csharpVisible(c, pf, fromSym.namespace));
      if (visible.length === 1) return { sym: visible[0], conf: 1 };
      const pool = visible.length ? visible : all;
      const sameFile = pool.find((c) => c.file === pf.file);
      if (sameFile) return { sym: sameFile, conf: 0.9 };
      // prefer the deepest namespace match
      const ns = fromSym.namespace ?? '';
      pool.sort((a, b) => commonPrefix(b.namespace ?? '', ns) - commonPrefix(a.namespace ?? '', ns));
      return { sym: pool[0], conf: 0.5 };
    }

    // TypeScript / JavaScript
    const dot = name.indexOf('.');
    const head = dot > 0 ? name.slice(0, dot) : name;
    const rest = dot > 0 ? name.slice(dot + 1) : undefined;
    const imp = pf.imports.find((i) => (i.alias ?? i.name) === head);
    if (imp) {
      const target = resolveTsModule(pf.file, imp.from);
      if (!target) return { conf: 0 }; // external package
      const tl = topLevelByFile.get(target);
      if (imp.name === '*') {
        if (!rest) return { conf: 0 };
        const s = tl?.get(rest.split('.')[0]);
        return s ? { sym: s, conf: 1 } : { conf: 0 };
      }
      const s = tl?.get(imp.name);
      if (s) return { sym: s, conf: 1 };
      // re-export through an index/barrel file: search files it re-exports
      const tpf = parsedByFile.get(target);
      for (const spec of tpf?.usings ?? []) {
        const f2 = resolveTsModule(target, spec);
        const s2 = f2 ? topLevelByFile.get(f2)?.get(imp.name) : undefined;
        if (s2) return { sym: s2, conf: 0.9 };
      }
      return { conf: 0 };
    }
    const local = topLevelByFile.get(pf.file)?.get(head);
    if (local) return { sym: local, conf: 1 };
    // Namespaced / global script code (e.g. Cocos 2.x, triple-slash namespaces)
    const q = byQualified.get(name);
    if (q?.length) return { sym: q[0], conf: 0.8 };
    const g = (typesByName.get(head) ?? []).filter((c) => c.language !== 'csharp' && TYPE_KINDS.has(c.kind));
    if (g.length === 1 && !pf.imports.length) return { sym: g[0], conf: 0.6 };
    return { conf: 0 };
  };

  /** Type of a value expression's head: a type name, or (fallback) a member of the current type, e.g. an inherited property. */
  const resolveValueHead = (name: string, fromSym: SymbolInfo, pf: ParsedFile): { sym?: SymbolInfo; conf: number } => {
    const r = resolveType(name, fromSym, pf);
    if (r.sym || name.includes('.') || name.startsWith('@')) return r;
    const owner = ownerType(fromSym);
    const mem = owner && TYPE_KINDS.has(owner.kind) ? findMember(owner, name, undefined) : undefined;
    if (mem?.returnType && !CALLABLE_KINDS.has(mem.kind)) {
      const mr = resolveType(mem.returnType, mem, parsedByFile.get(mem.file) ?? pf);
      return { sym: mr.sym, conf: mr.conf * 0.9 };
    }
    return r;
  };

  /** "@Head|member|member" → walk member return types across files. */
  const resolveChain = (encoded: string, fromSym: SymbolInfo, pf: ParsedFile): { sym?: SymbolInfo; conf: number } => {
    const parts = encoded.slice(1).split('|');
    const head = resolveValueHead(parts[0], fromSym, pf);
    let t = head.sym;
    let conf = head.conf;
    for (const m of parts.slice(1)) {
      if (!t || !TYPE_KINDS.has(t.kind)) return { conf: 0 };
      const mem = findMember(t, m, undefined);
      if (!mem) return { conf: 0 };
      if (TYPE_KINDS.has(mem.kind)) {
        t = mem; // nested type access
        continue;
      }
      if (!mem.returnType || CALLABLE_KINDS.has(mem.kind)) return { conf: 0 };
      const r = resolveType(mem.returnType, mem, parsedByFile.get(mem.file) ?? pf);
      t = r.sym;
      conf *= r.conf;
    }
    return t ? { sym: t, conf: conf * 0.95 } : { conf: 0 };
  };

  // ---------------------------------------------------------------- member resolution
  const baseTypesOf = (t: SymbolInfo): SymbolInfo[] => {
    const pf = parsedByFile.get(t.file);
    if (!pf) return [];
    const res: SymbolInfo[] = [];
    const group = partialGroups.get(t.qualifiedName) ?? [t];
    for (const g of group) for (const b of g.baseTypes ?? []) {
      const r = resolveType(b, g, parsedByFile.get(g.file) ?? pf);
      if (r.sym && r.sym !== t) res.push(r.sym);
    }
    return res;
  };

  const findMember = (t: SymbolInfo, name: string, arity: number | undefined, depth = 0): SymbolInfo | undefined => {
    if (depth > 8) return undefined;
    const group = partialGroups.get(t.qualifiedName) ?? [t];
    const cands: SymbolInfo[] = [];
    for (const g of group) for (const m of members.get(g.id) ?? []) if (m.name === name) cands.push(m);
    if (cands.length) {
      if (arity !== undefined) {
        const exact = cands.find((c) => c.parameters?.length === arity);
        if (exact) return exact;
      }
      return cands[0];
    }
    for (const b of baseTypesOf(t)) {
      const m = findMember(b, name, arity, depth + 1);
      if (m) return m;
    }
    return undefined;
  };

  // ---------------------------------------------------------------- relationships
  const rels: Relationship[] = [];
  const seen = new Set<string>();
  const addRel = (source: string, target: string, type: RelationshipType, confidence: number, file: string, line: number, detail?: string): void => {
    if (source === target) return;
    const k = `${source}|${target}|${type}`;
    if (seen.has(k)) return;
    seen.add(k);
    rels.push({ source, target, type, confidence: Math.round(confidence * 100) / 100, location: { file, line }, detail });
  };

  for (const s of symbols) if (s.parent && byId.has(s.parent)) addRel(s.parent, s.id, 'contains', 1, s.file, s.startLine);

  for (const pf of parsed) {
    for (const r of pf.references) {
      const from = byId.get(r.from);
      if (!from) continue;
      const owner = ownerType(from) ?? from;
      handleRef(pf, r, from, owner);
    }
  }

  function handleRef(pf: ParsedFile, r: RawReference, from: SymbolInfo, owner: SymbolInfo): void {
    switch (r.kind) {
      case 'inherit': {
        const t = resolveType(r.name, from, pf);
        if (!t.sym) return;
        const type: RelationshipType = t.sym.kind === 'interface' && from.kind !== 'interface' ? 'implements' : 'inherits';
        addRel(from.id, t.sym.id, type, t.conf, pf.file, r.line);
        return;
      }
      case 'type': {
        const t = resolveType(r.name, from, pf);
        if (!t.sym || t.sym === owner) return;
        const structural = from === owner; // recorded on the type itself: field / property / ctor parameter
        addRel(owner.id, t.sym.id, structural ? 'depends_on' : 'references', t.conf, pf.file, r.line);
        return;
      }
      case 'new': {
        const t = resolveType(r.name, from, pf);
        if (!t.sym || t.sym === owner) return;
        addRel(owner.id, t.sym.id, 'creates', t.conf, pf.file, r.line);
        return;
      }
      case 'call': {
        let target: SymbolInfo | undefined;
        let conf = 1;
        if (pf.language === 'csharp') {
          if (TYPE_KINDS.has(owner.kind)) target = findMember(owner, r.name, r.arity);
          // could also be a delegate field invocation or a local function: ignore when unresolved
        } else {
          const t = resolveType(r.name, from, pf);
          if (t.sym && CALLABLE_KINDS.has(t.sym.kind)) {
            target = t.sym;
            conf = t.conf;
          } else if (t.sym && TYPE_KINDS.has(t.sym.kind)) {
            addRel(owner.id, t.sym.id, 'references', t.conf, pf.file, r.line);
          }
        }
        if (target && target !== from) linkCall(from, owner, target, conf, pf.file, r.line);
        return;
      }
      case 'member-call': {
        let target: SymbolInfo | undefined;
        let conf = 1;
        let receiverResolved = false;
        if (r.receiverType) {
          const t = resolveValueHead(r.receiverType, from, pf);
          receiverResolved = !!t.sym;
          if (t.sym && TYPE_KINDS.has(t.sym.kind)) {
            target = findMember(t.sym, r.name, r.arity);
            conf = t.conf;
            if (!target && t.sym !== owner) addRel(owner.id, t.sym.id, 'references', t.conf, pf.file, r.line);
          } else if (t.sym && !t.sym.parent && pf.language !== 'csharp') {
            // namespace-import style: utils.doThing()
            target = t.sym.name === r.name ? t.sym : undefined;
          }
        }
        if (!target && !receiverResolved && !GENERIC_MEMBER_NAMES.has(r.name) && r.name.length > 3) {
          const cands = (callablesByName.get(r.name) ?? []).filter((c) => c.language === from.language || (c.language !== 'csharp') === (from.language !== 'csharp'));
          if (cands.length === 1) {
            target = cands[0];
            conf = 0.4;
          }
        }
        if (target && target !== from) linkCall(from, owner, target, conf, pf.file, r.line);
        return;
      }
      case 'event-sub':
      case 'event-pub': {
        const relType: RelationshipType = r.kind === 'event-sub' ? 'subscribes_to' : 'publishes';
        if (r.receiverType) {
          // member-level event: x.OnChanged += ..., OnChanged?.Invoke()
          const t = resolveValueHead(r.receiverType, from, pf);
          if (!t.sym || !TYPE_KINDS.has(t.sym.kind)) return;
          const ev = findMember(t.sym, r.name, undefined);
          if (!ev) return;
          const isEvent = ev.modifiers?.includes('event') || (ev.returnType && DELEGATE_TYPE.test(ev.returnType));
          if (!isEvent) return;
          addRel(owner.id, ev.id, relType, t.conf, pf.file, r.line, `${t.sym.name}.${ev.name}`);
          return;
        }
        const t = resolveType(r.name, from, pf);
        if (t.sym && t.sym !== owner) addRel(owner.id, t.sym.id, relType, t.conf * 0.8, pf.file, r.line);
        return;
      }
    }
  }

  function linkCall(from: SymbolInfo, owner: SymbolInfo, target: SymbolInfo, conf: number, file: string, line: number): void {
    const caller = CALLABLE_KINDS.has(from.kind) || from.kind === 'property' || from.kind === 'field' ? from : from;
    addRel(caller.id, target.id, 'calls', conf, file, line);
    const tOwner = ownerType(target) ?? target;
    if (tOwner !== owner) addRel(owner.id, tOwner.id, 'references', conf, file, line);
  }

  // ---------------------------------------------------------------- dependency injection
  const implementsOf = new Map<string, string[]>();
  for (const r of rels) if (r.type === 'implements' || r.type === 'inherits') push(implementsOf, r.source, r.target);
  const allInterfaces = (id: string, acc = new Set<string>()): Set<string> => {
    for (const b of implementsOf.get(id) ?? []) {
      if (acc.has(b)) continue;
      if (byId.get(b)?.kind === 'interface') acc.add(b);
      allInterfaces(b, acc);
    }
    return acc;
  };

  const registrations: DIRegistration[] = [];
  const containers = new Set<string>();
  for (const pf of parsed) {
    for (const d of pf.di) {
      containers.add(d.container);
      const scope = d.scopeSymbol ? byId.get(d.scopeSymbol) : undefined;
      const ctx = scope ?? pf.symbols[0];
      if (!ctx) continue;
      const impl = resolveValueHead(d.implementation, ctx, pf).sym;
      // chain-registered components ("@GameManager|GamePlay|MapManagerProp") are displayed by their resolved type
      const implName = impl?.name ?? d.implementation.split('|').pop()!.replace(/^@/, '');
      const base = { ...d, implementation: implName };
      if (d.service === '*interfaces*') {
        const ifaces = impl ? [...allInterfaces(impl.id)] : [];
        if (!ifaces.length) registrations.push({ ...base, service: implName, implementationId: impl?.id, serviceId: impl?.id });
        for (const i of ifaces) registrations.push({ ...base, service: byId.get(i)!.name, serviceId: i, implementationId: impl?.id });
      } else if (d.service === d.implementation) {
        registrations.push({ ...base, service: implName, serviceId: impl?.id, implementationId: impl?.id });
      } else {
        const svc = resolveType(d.service, ctx, pf).sym;
        registrations.push({ ...base, serviceId: svc?.id, implementationId: impl?.id });
      }
      const scopeType = ownerType(scope);
      if (scopeType && impl) addRel(scopeType.id, impl.id, 'registers', 1, pf.file, d.line, d.lifetime);
    }
  }
  const injections: DIInfo['injections'] = [];
  for (const pf of parsed) {
    for (const inj of pf.injections) {
      const consumer = byId.get(inj.consumer);
      if (!consumer) continue;
      const t = resolveType(inj.type, consumer, pf).sym;
      const providers: number[] = [];
      registrations.forEach((reg, idx) => {
        if (t && (reg.serviceId === t.id || (reg.serviceId === undefined && reg.service === t.name))) providers.push(idx);
      });
      const consumerRegistered = registrations.some((r) => r.implementationId === consumer.id);
      const explicit = inj.via !== 'constructor';
      if (!t && !explicit) continue;
      if (!explicit && !providers.length && !consumerRegistered) continue;
      injections.push({ ...inj, typeId: t?.id, providers });
      if (t) addRel(consumer.id, t.id, 'injects', providers.length ? 1 : 0.7, pf.file, inj.line, inj.via);
    }
  }

  return { symbols, relationships: rels, di: { containers: [...containers].sort(), registrations, injections } };
}

function commonPrefix(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  let n = 0;
  while (n < pa.length && n < pb.length && pa[n] === pb[n]) n++;
  return n;
}
