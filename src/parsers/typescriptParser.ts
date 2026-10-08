import ts from 'typescript';
import { Language, ParsedFile, RawReference, SymbolInfo, SymbolKind } from '../model/types';
import { fingerprint } from './fingerprint';

const BUILTIN_TYPES = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'void', 'never', 'object', 'undefined', 'null', 'bigint', 'symbol',
  'Array', 'Promise', 'Record', 'Partial', 'Readonly', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'Error', 'RegExp',
  'Function', 'Object', 'String', 'Number', 'Boolean', 'Pick', 'Omit', 'ReturnType', 'Parameters', 'InstanceType',
  'Required', 'NonNullable', 'Exclude', 'Extract', 'Awaited', 'ReadonlyArray', 'Iterable', 'Generator', 'console', 'Math', 'JSON',
]);

const EVENT_SUB = new Set(['on', 'once', 'addListener', 'addEventListener', 'subscribe', 'listen', 'connect']);
const EVENT_PUB = new Set(['emit', 'dispatchEvent', 'dispatch', 'next', 'publish', 'fire', 'trigger', 'broadcast']);

interface ClassCtx {
  sym: SymbolInfo;
  fields: Map<string, string>;
}

export function parseTypeScript(file: string, src: string, hash: string, language: Language): ParsedFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : language === 'javascript' ? (file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS) : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const out: ParsedFile = {
    file,
    hash,
    language,
    usings: [],
    imports: [],
    symbols: [],
    references: [],
    di: [],
    injections: [],
    methodFingerprints: [],
  };
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const endLine = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
  const importedNames = new Set<string>();
  const memberCounts = new Map<string, number>();
  let topLevelInit: SymbolInfo | undefined;

  const ref = (from: string, name: string, k: RawReference['kind'], l: number, extra?: Partial<RawReference>): void => {
    if (!name || BUILTIN_TYPES.has(name)) return;
    out.references.push({ from, name, kind: k, line: l, ...extra });
  };

  const uniqueId = (base: string): string => {
    const c = (memberCounts.get(base) ?? 0) + 1;
    memberCounts.set(base, c);
    return c > 1 ? `${base}~${c}` : base;
  };

  const modifiersOf = (n: ts.Node): { vis?: string; mods: string[]; exported: boolean; decorators: string[] } => {
    const mods: string[] = [];
    let vis: string | undefined;
    let exported = false;
    const decorators: string[] = [];
    const list = ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : [];
    for (const m of list) {
      switch (m.kind) {
        case ts.SyntaxKind.ExportKeyword: exported = true; break;
        case ts.SyntaxKind.DefaultKeyword: mods.push('default'); break;
        case ts.SyntaxKind.PublicKeyword: vis = 'public'; break;
        case ts.SyntaxKind.PrivateKeyword: vis = 'private'; break;
        case ts.SyntaxKind.ProtectedKeyword: vis = 'protected'; break;
        case ts.SyntaxKind.StaticKeyword: mods.push('static'); break;
        case ts.SyntaxKind.AbstractKeyword: mods.push('abstract'); break;
        case ts.SyntaxKind.ReadonlyKeyword: mods.push('readonly'); break;
        case ts.SyntaxKind.AsyncKeyword: mods.push('async'); break;
      }
    }
    const decs = ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : [];
    for (const d of decs) {
      const e = d.expression;
      const callee = ts.isCallExpression(e) ? e.expression : e;
      decorators.push(callee.getText(sf));
    }
    if (n.getText(sf).startsWith('#')) vis = 'private';
    return { vis, mods, exported, decorators };
  };

  /** Collects type names referenced by a type node. */
  const typeNames = (t: ts.TypeNode | undefined): string[] => {
    const names: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isTypeReferenceNode(n)) names.push(n.typeName.getText(sf));
      else if (ts.isExpressionWithTypeArguments(n)) names.push(n.expression.getText(sf));
      else if (ts.isTypeQueryNode(n)) names.push(n.exprName.getText(sf));
      ts.forEachChild(n, visit);
    };
    if (t) visit(t);
    return names;
  };
  const mainType = (t: ts.TypeNode | undefined): string | undefined => {
    if (!t) return undefined;
    if (ts.isTypeReferenceNode(t)) {
      const nm = t.typeName.getText(sf);
      // unwrap common containers so Array<Foo> / Promise<Foo> point at Foo
      if (['Array', 'Promise', 'ReadonlyArray', 'Readonly', 'Partial'].includes(nm) && t.typeArguments?.length) return mainType(t.typeArguments[0]);
      return nm;
    }
    if (ts.isArrayTypeNode(t)) return mainType(t.elementType);
    if (ts.isUnionTypeNode(t)) {
      const nonNull = t.types.filter((x) => x.kind !== ts.SyntaxKind.NullKeyword && x.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword));
      return nonNull.length === 1 ? mainType(nonNull[0]) : undefined;
    }
    return undefined;
  };

  // ---------------------------------------------------------------- bodies
  const scanBody = (owner: SymbolInfo, body: ts.Node, cls: ClassCtx | undefined, locals: Map<string, string>): void => {
    const norm: string[] = [];
    const seenTypes = new Set<string>();
    const typeOfExpr = (e: ts.Expression): string | undefined => {
      if (e.kind === ts.SyntaxKind.ThisKeyword) return cls?.sym.name;
      if (ts.isIdentifier(e)) return locals.get(e.text) ?? (importedNames.has(e.text) || /^[A-Z]/.test(e.text) ? e.text : undefined);
      if (ts.isPropertyAccessExpression(e)) {
        if (e.expression.kind === ts.SyntaxKind.ThisKeyword) return cls?.fields.get(e.name.text) ?? (cls ? `@${cls.sym.name}|${e.name.text}` : undefined);
        // a.b.c → chain resolved across files by the resolver
        const base = typeOfExpr(e.expression);
        return base ? (base.startsWith('@') ? base : '@' + base) + '|' + e.name.text : undefined;
      }
      if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) {
        if (ts.isAsExpression(e)) return mainType(e.type) ?? typeOfExpr(e.expression);
        return typeOfExpr(e.expression);
      }
      return undefined;
    };
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) norm.push(locals.has(n.text) ? '$v' : n.text);
      else if (ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) norm.push('$lit');
      else norm.push(String(n.kind));

      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const init = n.initializer;
        const t = mainType(n.type) ?? (init && ts.isNewExpression(init) ? init.expression.getText(sf) : undefined)
          ?? (init && (ts.isPropertyAccessExpression(init) || ts.isAsExpression(init)) ? typeOfExpr(init) : undefined);
        if (t) locals.set(n.name.text, t);
        for (const tn of typeNames(n.type)) if (!seenTypes.has(tn)) {
          seenTypes.add(tn);
          ref(owner.id, tn, 'type', line(n));
        }
      } else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parameters) {
        for (const p of n.parameters) {
          if (ts.isIdentifier(p.name)) {
            const t = mainType(p.type);
            if (t) locals.set(p.name.text, t);
          }
        }
      } else if (ts.isNewExpression(n)) {
        const nm = n.expression.getText(sf);
        if (/^[A-Za-z_$][\w$.]*$/.test(nm)) {
          ref(owner.id, nm, 'new', line(n));
          seenTypes.add(nm);
        }
      } else if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const arity = n.arguments.length;
        if (ts.isIdentifier(callee)) {
          ref(owner.id, callee.text, 'call', line(n), { receiverType: undefined, arity });
        } else if (ts.isPropertyAccessExpression(callee) || ts.isPropertyAccessChain(callee)) {
          const pa = callee as ts.PropertyAccessExpression;
          const name = pa.name.text;
          const receiverType = typeOfExpr(pa.expression);
          ref(owner.id, name, 'member-call', line(n), { receiverType, arity });
          if (EVENT_SUB.has(name) && receiverType) ref(owner.id, receiverType, 'event-sub', line(n));
          if (EVENT_PUB.has(name) && receiverType) ref(owner.id, receiverType, 'event-pub', line(n));
          detectDI(owner, n, name, pa.expression, cls);
        }
      } else if (ts.isTypeReferenceNode(n)) {
        const nm = n.typeName.getText(sf);
        if (!seenTypes.has(nm)) {
          seenTypes.add(nm);
          ref(owner.id, nm, 'type', line(n));
        }
      } else if (ts.isIdentifier(n) && importedNames.has(n.text) && !seenTypes.has(n.text)) {
        // usage of an imported binding (e.g. passing a class or calling a static)
        const p = n.parent;
        if (!(ts.isCallExpression(p) && p.expression === n) && !(ts.isNewExpression(p) && p.expression === n)) {
          seenTypes.add(n.text);
          ref(owner.id, n.text, 'type', line(n));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    const fp = fingerprint(norm);
    if (fp) out.methodFingerprints.push({ id: owner.id, tokens: norm.length, shingles: fp });
  };

  const detectDI = (owner: SymbolInfo, call: ts.CallExpression, name: string, receiver: ts.Expression, cls: ClassCtx | undefined): void => {
    const recv = receiver.getText(sf);
    const l = line(call);
    const push = (container: string, service: string, impl: string, method: string, lifetime?: string): void => {
      out.di.push({ file, line: l, container, scopeSymbol: cls?.sym.id ?? owner.id, service, implementation: impl, method, lifetime });
    };
    const argName = (a: ts.Expression | undefined): string | undefined => {
      if (!a) return undefined;
      if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) return a.getText(sf);
      if (ts.isStringLiteral(a)) return a.text;
      return undefined;
    };
    // tsyringe: container.register(Token, { useClass: Impl }) / registerSingleton(Token, Impl)
    if (/container/i.test(recv) && (name === 'register' || name === 'registerSingleton' || name === 'registerType')) {
      const svc = argName(call.arguments[0]);
      let impl = argName(call.arguments[1]);
      const opt = call.arguments[1];
      if (opt && ts.isObjectLiteralExpression(opt)) {
        for (const p of opt.properties) {
          if (ts.isPropertyAssignment(p) && ['useClass', 'useValue', 'useFactory', 'useToken'].includes(p.name.getText(sf))) impl = argName(p.initializer);
        }
      }
      if (svc) push('tsyringe', svc, impl ?? svc, name, name === 'registerSingleton' ? 'Singleton' : undefined);
      return;
    }
    // inversify: container.bind<IFoo>(TYPES.Foo).to(Foo).inSingletonScope()
    if (name === 'to' || name === 'toSelf') {
      let inner: ts.Expression = receiver;
      while (ts.isCallExpression(inner) || ts.isPropertyAccessExpression(inner)) {
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === 'bind') {
          const svc = inner.typeArguments?.[0]?.getText(sf) ?? argName(inner.arguments[0]);
          const impl = name === 'toSelf' ? argName(inner.arguments[0]) : argName(call.arguments[0]);
          let lifetime: string | undefined;
          let p: ts.Node = call.parent;
          while (p && (ts.isPropertyAccessExpression(p) || ts.isCallExpression(p))) {
            if (ts.isPropertyAccessExpression(p) && /^in(\w+)Scope$/.test(p.name.text)) lifetime = /^in(\w+)Scope$/.exec(p.name.text)![1];
            p = p.parent;
          }
          if (svc && impl) push('inversify', svc, impl, 'bind', lifetime);
          return;
        }
        inner = ts.isCallExpression(inner) ? inner.expression : inner.expression;
      }
    }
  };

  // ---------------------------------------------------------------- declarations
  const addSym = (s: SymbolInfo): SymbolInfo => {
    out.symbols.push(s);
    return s;
  };

  const visitClassLike = (n: ts.ClassLikeDeclaration | ts.InterfaceDeclaration, prefix: string, nsName: string | undefined): void => {
    const name = n.name?.text ?? 'default';
    const q = prefix ? `${prefix}.${name}` : name;
    const m = modifiersOf(n);
    const kind: SymbolKind = ts.isInterfaceDeclaration(n) ? 'interface' : 'class';
    const sym = addSym({
      id: `${file}#${q}`,
      name,
      qualifiedName: q,
      kind,
      language,
      file,
      namespace: nsName,
      visibility: m.exported ? 'export' : 'module',
      modifiers: m.mods,
      attributes: m.decorators.length ? m.decorators : undefined,
      baseTypes: [],
      startLine: line(n),
      endLine: endLine(n),
      exported: m.exported,
    });
    const cls: ClassCtx = { sym, fields: new Map() };
    for (const h of n.heritageClauses ?? []) {
      for (const t of h.types) {
        const bn = t.expression.getText(sf);
        sym.baseTypes!.push(bn);
        ref(sym.id, bn, 'inherit', line(t));
        for (const ta of t.typeArguments ?? []) for (const tn of typeNames(ta)) ref(sym.id, tn, 'type', line(t));
      }
    }
    const injectable = m.decorators.some((d) => /^(injectable|Injectable|singleton|scoped|autoInjectable|Service|Controller|Component)$/.test(d));
    const bodies: { owner: SymbolInfo; body: ts.Node; locals: Map<string, string> }[] = [];

    for (const mem of n.members) {
      const mm = modifiersOf(mem);
      const memName = mem.name ? (ts.isIdentifier(mem.name) || ts.isPrivateIdentifier(mem.name) || ts.isStringLiteral(mem.name) ? mem.name.text : mem.name.getText(sf)) : undefined;
      if (ts.isConstructorDeclaration(mem)) {
        const params = mem.parameters;
        const ctor = addSym({
          id: uniqueId(`${sym.id}.constructor(${params.length})`),
          name: 'constructor',
          qualifiedName: `${q}.constructor`,
          kind: 'constructor',
          language,
          file,
          namespace: nsName,
          parent: sym.id,
          visibility: mm.vis ?? 'public',
          parameters: params.map((p) => mainType(p.type) ?? p.type?.getText(sf) ?? 'any'),
          startLine: line(mem),
          endLine: endLine(mem),
        });
        const locals = new Map<string, string>();
        for (const p of params) {
          const t = mainType(p.type);
          const pm = modifiersOf(p);
          const pname = ts.isIdentifier(p.name) ? p.name.text : undefined;
          if (pname && t) locals.set(pname, t);
          for (const tn of typeNames(p.type)) ref(sym.id, tn, 'type', line(p));
          const injectDec = pm.decorators.find((d) => d === 'inject' || d === 'Inject');
          if (injectDec && ts.canHaveDecorators(p)) {
            const dec = (ts.getDecorators(p) ?? [])[0];
            const tok = dec && ts.isCallExpression(dec.expression) ? dec.expression.arguments[0]?.getText(sf) : undefined;
            if (tok) out.injections.push({ consumer: sym.id, type: tok, line: line(p), via: 'decorator' });
          } else if (t && (injectable || pm.vis || pm.mods.includes('readonly'))) {
            out.injections.push({ consumer: sym.id, type: t, line: line(p), via: 'constructor' });
          }
          // parameter properties become fields
          if (pname && (pm.vis || pm.mods.includes('readonly'))) {
            if (t) cls.fields.set(pname, t);
            addSym({
              id: uniqueId(`${sym.id}.${pname}`),
              name: pname,
              qualifiedName: `${q}.${pname}`,
              kind: 'field',
              language,
              file,
              namespace: nsName,
              parent: sym.id,
              visibility: pm.vis ?? 'public',
              modifiers: pm.mods,
              returnType: t,
              startLine: line(p),
              endLine: line(p),
            });
          }
        }
        if (mem.body) bodies.push({ owner: ctor, body: mem.body, locals });
        continue;
      }
      if (!memName) continue;
      if (ts.isMethodDeclaration(mem) || ts.isMethodSignature(mem) || ts.isGetAccessorDeclaration(mem) || ts.isSetAccessorDeclaration(mem)) {
        const isAccessor = ts.isGetAccessorDeclaration(mem) || ts.isSetAccessorDeclaration(mem);
        const params = mem.parameters;
        const s = addSym({
          id: uniqueId(isAccessor ? `${sym.id}.${memName}` : `${sym.id}.${memName}(${params.length})`),
          name: memName,
          qualifiedName: `${q}.${memName}`,
          kind: isAccessor ? 'property' : 'method',
          language,
          file,
          namespace: nsName,
          parent: sym.id,
          visibility: mm.vis ?? (kind === 'interface' ? 'public' : 'public'),
          modifiers: [...mm.mods, ...(ts.isGetAccessorDeclaration(mem) ? ['get'] : ts.isSetAccessorDeclaration(mem) ? ['set'] : [])],
          attributes: mm.decorators.length ? mm.decorators : undefined,
          parameters: params.map((p) => mainType(p.type) ?? p.type?.getText(sf) ?? 'any'),
          returnType: mainType(mem.type),
          startLine: line(mem),
          endLine: endLine(mem),
        });
        const locals = new Map<string, string>();
        for (const p of params) {
          const t = mainType(p.type);
          if (ts.isIdentifier(p.name) && t) locals.set(p.name.text, t);
          for (const tn of typeNames(p.type)) ref(s.id, tn, 'type', line(p));
        }
        for (const tn of typeNames(mem.type)) ref(s.id, tn, 'type', line(mem));
        const body = 'body' in mem ? mem.body : undefined;
        if (body) bodies.push({ owner: s, body, locals });
        continue;
      }
      if (ts.isPropertyDeclaration(mem) || ts.isPropertySignature(mem)) {
        const init = ts.isPropertyDeclaration(mem) ? mem.initializer : undefined;
        const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const t = mainType(mem.type) ?? (init && ts.isNewExpression(init) ? init.expression.getText(sf) : undefined);
        const s = addSym({
          id: uniqueId(isFn ? `${sym.id}.${memName}(${(init as ts.ArrowFunction).parameters.length})` : `${sym.id}.${memName}`),
          name: memName,
          qualifiedName: `${q}.${memName}`,
          kind: isFn ? 'method' : kind === 'interface' ? 'property' : 'field',
          language,
          file,
          namespace: nsName,
          parent: sym.id,
          visibility: mm.vis ?? 'public',
          modifiers: mm.mods,
          attributes: mm.decorators.length ? mm.decorators : undefined,
          returnType: t,
          startLine: line(mem),
          endLine: endLine(mem),
        });
        if (t) cls.fields.set(memName, t);
        for (const tn of typeNames(mem.type)) ref(sym.id, tn, 'type', line(mem));
        if (mm.decorators.some((d) => /^(property|Inject|inject|Input|ViewChild)$/.test(d)) && t) {
          out.injections.push({ consumer: sym.id, type: t, line: line(mem), via: 'decorator' });
        }
        if (init) {
          const locals = new Map<string, string>();
          if (isFn) for (const p of (init as ts.ArrowFunction).parameters) {
            const pt = mainType(p.type);
            if (ts.isIdentifier(p.name) && pt) locals.set(p.name.text, pt);
          }
          bodies.push({ owner: s, body: init, locals });
        }
      }
    }
    for (const b of bodies) scanBody(b.owner, b.body, cls, b.locals);
  };

  const visitTop = (stmts: ts.NodeArray<ts.Statement>, prefix: string, nsName: string | undefined): void => {
    for (const st of stmts) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const from = st.moduleSpecifier.text;
        out.usings.push(from);
        const cl = st.importClause;
        if (cl?.name) {
          out.imports.push({ name: 'default', from, alias: cl.name.text });
          importedNames.add(cl.name.text);
        }
        if (cl?.namedBindings) {
          if (ts.isNamedImports(cl.namedBindings)) {
            for (const el of cl.namedBindings.elements) {
              out.imports.push({ name: (el.propertyName ?? el.name).text, from, alias: el.name.text });
              importedNames.add(el.name.text);
            }
          } else {
            out.imports.push({ name: '*', from, alias: cl.namedBindings.name.text });
            importedNames.add(cl.namedBindings.name.text);
          }
        }
        continue;
      }
      if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        out.usings.push(st.moduleSpecifier.text);
        continue;
      }
      if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference) && ts.isStringLiteral(st.moduleReference.expression)) {
        out.usings.push(st.moduleReference.expression.text);
        out.imports.push({ name: '*', from: st.moduleReference.expression.text, alias: st.name.text });
        importedNames.add(st.name.text);
        continue;
      }
      if (ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)) {
        visitClassLike(st, prefix, nsName);
        continue;
      }
      if (ts.isModuleDeclaration(st) && st.body) {
        const nm = st.name.getText(sf).replace(/['"]/g, '');
        const q = prefix ? `${prefix}.${nm}` : nm;
        let body: ts.ModuleBody | undefined = st.body;
        let full = q;
        while (body && ts.isModuleDeclaration(body)) {
          full += '.' + body.name.getText(sf);
          body = body.body;
        }
        if (body && ts.isModuleBlock(body)) visitTop(body.statements, full, full);
        continue;
      }
      const m = modifiersOf(st);
      if (ts.isEnumDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
        const q = prefix ? `${prefix}.${st.name.text}` : st.name.text;
        const s = addSym({
          id: `${file}#${q}`,
          name: st.name.text,
          qualifiedName: q,
          kind: ts.isEnumDeclaration(st) ? 'enum' : 'type',
          language,
          file,
          namespace: nsName,
          visibility: m.exported ? 'export' : 'module',
          modifiers: m.mods,
          startLine: line(st),
          endLine: endLine(st),
          exported: m.exported,
        });
        if (ts.isTypeAliasDeclaration(st)) for (const tn of typeNames(st.type)) ref(s.id, tn, 'type', line(st));
        continue;
      }
      if (ts.isFunctionDeclaration(st)) {
        const name = st.name?.text ?? 'default';
        const q = prefix ? `${prefix}.${name}` : name;
        const s = addSym({
          id: uniqueId(`${file}#${q}(${st.parameters.length})`),
          name,
          qualifiedName: q,
          kind: 'function',
          language,
          file,
          namespace: nsName,
          visibility: m.exported ? 'export' : 'module',
          modifiers: m.mods,
          parameters: st.parameters.map((p) => mainType(p.type) ?? 'any'),
          returnType: mainType(st.type),
          startLine: line(st),
          endLine: endLine(st),
          exported: m.exported,
        });
        const locals = new Map<string, string>();
        for (const p of st.parameters) {
          const t = mainType(p.type);
          if (ts.isIdentifier(p.name) && t) locals.set(p.name.text, t);
          for (const tn of typeNames(p.type)) ref(s.id, tn, 'type', line(p));
        }
        for (const tn of typeNames(st.type)) ref(s.id, tn, 'type', line(st));
        if (st.body) scanBody(s, st.body, undefined, locals);
        continue;
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const init = d.initializer;
          const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
          if (init && ts.isClassExpression(init)) {
            visitClassLike(init, prefix, nsName);
            continue;
          }
          const q = prefix ? `${prefix}.${d.name.text}` : d.name.text;
          const s = addSym({
            id: uniqueId(isFn ? `${file}#${q}(${(init as ts.ArrowFunction).parameters.length})` : `${file}#${q}`),
            name: d.name.text,
            qualifiedName: q,
            kind: isFn ? 'function' : 'variable',
            language,
            file,
            namespace: nsName,
            visibility: m.exported ? 'export' : 'module',
            modifiers: [...m.mods, (st.declarationList.flags & ts.NodeFlags.Const) ? 'const' : 'let'],
            returnType: mainType(d.type) ?? (init && ts.isNewExpression(init) ? init.expression.getText(sf) : undefined),
            startLine: line(st),
            endLine: endLine(st),
            exported: m.exported,
          });
          for (const tn of typeNames(d.type)) ref(s.id, tn, 'type', line(d));
          if (init) {
            const locals = new Map<string, string>();
            if (isFn) for (const p of (init as ts.ArrowFunction).parameters) {
              const pt = mainType(p.type);
              if (ts.isIdentifier(p.name) && pt) locals.set(p.name.text, pt);
              for (const tn of typeNames(p.type)) ref(s.id, tn, 'type', line(p));
            }
            scanBody(s, init, undefined, locals);
          }
        }
        continue;
      }
      if (ts.isExpressionStatement(st) || ts.isIfStatement(st) || ts.isForStatement(st) || ts.isForOfStatement(st) || ts.isTryStatement(st) || ts.isBlock(st)) {
        // Top-level executable code (bootstrapping, container wiring) is attributed to a per-file init symbol.
        if (!topLevelInit) {
          const base = file.slice(file.lastIndexOf('/') + 1);
          topLevelInit = addSym({
            id: `${file}#(top-level)`,
            name: `(top-level) ${base}`,
            qualifiedName: `(top-level) ${base}`,
            kind: 'function',
            language,
            file,
            namespace: nsName,
            visibility: 'module',
            modifiers: ['init'],
            startLine: line(st),
            endLine: endLine(st),
          });
        }
        topLevelInit.endLine = endLine(st);
        scanBody(topLevelInit, st, undefined, new Map());
        continue;
      }
      if (ts.isExportAssignment(st)) {
        // export default Foo;  -> mark Foo as default export
        const nm = st.expression.getText(sf);
        const target = out.symbols.find((s) => s.name === nm && !s.parent);
        if (target) target.modifiers = [...(target.modifiers ?? []), 'default'];
      }
    }
  };

  try {
    visitTop(sf.statements, '', undefined);
  } catch (e) {
    out.errors = [String(e)];
  }
  return out;
}
