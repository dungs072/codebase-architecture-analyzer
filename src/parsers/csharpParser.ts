import { ParsedFile, RawDIRegistration, RawInjectionPoint, RawReference, SymbolInfo, SymbolKind } from '../model/types';
import { fingerprint } from './fingerprint';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokType = 'id' | 'p' | 'str' | 'num';
interface Tok {
  t: TokType;
  v: string;
  l: number;
}

const MULTI_PUNCT = ['??=', '<<=', '=>', '?.', '??', '::', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '->'];

export function tokenizeCSharp(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = true;
  const n = src.length;

  const skipString = (verbatim: boolean, interpolated: boolean): void => {
    // assumes src[i] === '"'
    i++;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\n') line++;
      if (interpolated && depth > 0) {
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '"') {
          skipString(false, false);
          continue;
        } else if (c === '@' && src[i + 1] === '"') {
          i++;
          skipString(true, false);
          continue;
        } else if (c === '$' && src[i + 1] === '"') {
          i++;
          skipString(false, true);
          continue;
        }
        i++;
        continue;
      }
      if (interpolated && c === '{') {
        if (src[i + 1] === '{') {
          i += 2;
          continue;
        }
        depth++;
        i++;
        continue;
      }
      if (!verbatim && c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') {
        if (verbatim && src[i + 1] === '"') {
          i += 2;
          continue;
        }
        i++;
        return;
      }
      if (!verbatim && c === '\n') return; // unterminated, recover
      i++;
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      lineStart = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#' && lineStart) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    lineStart = false;
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    // raw string literals """..."""  (optionally $-prefixed)
    const rawStart = src.startsWith('"""', i) ? i : (src[i] === '$' && /^\$+"""/.test(src.slice(i, i + 8)) ? src.indexOf('"', i) : -1);
    if (rawStart >= 0) {
      const l0 = line;
      let q = 0;
      let j = rawStart;
      while (src[j] === '"') {
        q++;
        j++;
      }
      const close = src.indexOf('"'.repeat(q), j);
      const end = close < 0 ? n : close + q;
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end;
      out.push({ t: 'str', v: '""', l: l0 });
      continue;
    }
    if (c === '"' || ((c === '@' || c === '$') && (src[i + 1] === '"' || ((src[i + 1] === '@' || src[i + 1] === '$') && src[i + 2] === '"')))) {
      const l0 = line;
      let verbatim = false;
      let interp = false;
      while (src[i] === '@' || src[i] === '$') {
        if (src[i] === '@') verbatim = true;
        else interp = true;
        i++;
      }
      skipString(verbatim, interp);
      out.push({ t: 'str', v: '""', l: l0 });
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'" && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      out.push({ t: 'str', v: "''", l: line });
      continue;
    }
    if (/[A-Za-z_@À-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_À-￿]/.test(src[j])) j++;
      let v = src.slice(i, j);
      if (v.startsWith('@')) v = v.slice(1);
      out.push({ t: 'id', v, l: line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) {
        if (src[j] === '.' && !/[0-9]/.test(src[j + 1] ?? '')) break;
        j++;
      }
      out.push({ t: 'num', v: '0', l: line });
      i = j;
      continue;
    }
    let matched = false;
    for (const p of MULTI_PUNCT) {
      if (src.startsWith(p, i)) {
        out.push({ t: 'p', v: p, l: line });
        i += p.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    out.push({ t: 'p', v: c, l: line });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structural parser
// ---------------------------------------------------------------------------

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'abstract', 'sealed', 'virtual', 'override', 'readonly',
  'const', 'extern', 'unsafe', 'volatile', 'async', 'partial', 'new', 'event', 'required', 'file', 'fixed', 'ref', 'implicit', 'explicit',
]);
const TYPE_KEYWORDS = new Set(['class', 'struct', 'interface', 'enum', 'record']);
const KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal',
  'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for',
  'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object',
  'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short',
  'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked',
  'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while', 'var', 'dynamic', 'nameof', 'await', 'async', 'yield', 'when',
  'where', 'get', 'set', 'init', 'add', 'remove', 'value', 'record', 'with', 'and', 'or', 'not', 'global', 'nint', 'nuint', 'required',
]);
const PRIMITIVES = new Set(['bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint', 'long', 'ulong', 'short', 'ushort', 'object', 'string', 'void', 'var', 'dynamic', 'nint', 'nuint']);
const VISIBILITY = ['public', 'private', 'protected', 'internal'];

interface TypeCtx {
  sym: SymbolInfo;
  fields: Map<string, string>; // member name -> type name (for receiver resolution)
  pendingBodies: { owner: SymbolInfo; start: number; end: number; locals: Map<string, string> }[];
  memberCount: Map<string, number>;
  isLifetimeScope: boolean;
}

export function parseCSharp(file: string, src: string, hash: string): ParsedFile {
  const toks = tokenizeCSharp(src);
  const result: ParsedFile = {
    file,
    hash,
    language: 'csharp',
    usings: [],
    imports: [],
    symbols: [],
    references: [],
    di: [],
    injections: [],
    methodFingerprints: [],
  };
  const p = new CSharpParser(file, toks, result);
  try {
    p.parseScope('', [], toks.length);
  } catch (e) {
    result.errors = [String(e)];
  }
  return result;
}

class CSharpParser {
  private i = 0;
  constructor(
    private readonly file: string,
    private readonly toks: Tok[],
    private readonly out: ParsedFile,
  ) {}

  private peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  private is(v: string, o = 0): boolean {
    const t = this.toks[this.i + o];
    return !!t && t.v === v && t.t !== 'str';
  }

  /** Index of the token matching the opener at `start` ({ ( [ <), or toks.length. */
  private matching(start: number): number {
    const open = this.toks[start].v;
    const close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : '>';
    let depth = 0;
    for (let k = start; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.t !== 'p') continue;
      if (t.v === open) depth++;
      else if (t.v === close) {
        depth--;
        if (depth === 0) return k;
      } else if (open === '<' && (t.v === ';' || t.v === '{' || t.v === '}' || t.v === '=>')) {
        return -1; // not a generic list
      }
    }
    return this.toks.length;
  }

  private skipTo(v: string, end: number): void {
    let depth = 0;
    while (this.i < end) {
      const t = this.toks[this.i];
      if (t.t === 'p') {
        if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
        else if (t.v === ')' || t.v === ']' || t.v === '}') {
          if (depth === 0 && t.v === v) return;
          depth--;
        } else if (depth === 0 && t.v === v) return;
      }
      this.i++;
    }
  }

  private readAttributes(): string[] {
    const attrs: string[] = [];
    while (this.is('[')) {
      const end = this.matching(this.i);
      // [assembly: X] / [field: X] etc.
      let k = this.i + 1;
      if (this.toks[k + 1]?.v === ':' && this.toks[k]?.t === 'id') k += 2;
      while (k < end) {
        const t = this.toks[k];
        if (t.t === 'id') {
          let name = t.v;
          while (this.toks[k + 1]?.v === '.' && this.toks[k + 2]?.t === 'id') {
            name += '.' + this.toks[k + 2].v;
            k += 2;
          }
          attrs.push(name.replace(/Attribute$/, ''));
          // skip args
          if (this.toks[k + 1]?.v === '(') k = this.matching(k + 1);
        }
        k++;
        while (k < end && this.toks[k].v !== ',') k++;
        k++;
      }
      this.i = end + 1;
    }
    return attrs;
  }

  parseScope(ns: string, typeStack: TypeCtx[], end: number): void {
    while (this.i < end) {
      const t = this.peek()!;
      if (t.v === '}' && t.t === 'p') return;
      if (t.v === ';') {
        this.i++;
        continue;
      }
      if (t.t === 'id' && t.v === 'using' && typeStack.length === 0) {
        this.parseUsing();
        continue;
      }
      if (t.t === 'id' && t.v === 'namespace') {
        this.i++;
        const name = this.readQualifiedName();
        const full = ns ? `${ns}.${name}` : name;
        if (this.is(';')) {
          this.i++;
          this.parseScope(full, typeStack, end); // file-scoped namespace
          return;
        }
        if (this.is('{')) {
          const close = this.matching(this.i);
          this.i++;
          this.parseScope(full, typeStack, close);
          this.i = close + 1;
        }
        continue;
      }
      if (t.t === 'id' && t.v === 'extern' && this.peek(1)?.v === 'alias') {
        this.skipTo(';', end);
        this.i++;
        continue;
      }
      const startIdx = this.i;
      const attrs = this.readAttributes();
      const mods: string[] = [];
      while (this.peek()?.t === 'id' && MODIFIERS.has(this.peek()!.v) && !(this.peek()!.v === 'new' && this.peek(1)?.v === '(')) {
        mods.push(this.peek()!.v);
        this.i++;
      }
      const kw = this.peek();
      if (kw?.t === 'id' && TYPE_KEYWORDS.has(kw.v) && this.peek(1)?.t === 'id' && !(kw.v === 'record' && this.peek(1)?.v === '(')) {
        this.parseType(ns, typeStack, attrs, mods, end);
        continue;
      }
      if (kw?.t === 'id' && kw.v === 'delegate') {
        this.parseDelegate(ns, typeStack, mods);
        continue;
      }
      if (typeStack.length > 0) {
        this.parseMember(typeStack[typeStack.length - 1], attrs, mods, end);
        continue;
      }
      // Top-level statements or something we do not understand: skip a statement.
      this.skipTo(';', end);
      if (this.is('}')) {
        this.i++;
      } else {
        this.i++;
      }
      if (this.i === startIdx) this.i++;
    }
  }

  private readQualifiedName(): string {
    let name = '';
    while (this.peek()?.t === 'id') {
      name += this.peek()!.v;
      this.i++;
      if (this.is('.') || this.is('::')) {
        name += '.';
        this.i++;
      } else break;
    }
    return name;
  }

  private parseUsing(): void {
    this.i++; // using
    if (this.is('(')) {
      // using statement at top-level (scripts) – skip
      this.skipTo(';', this.toks.length);
      this.i++;
      return;
    }
    if (this.peek()?.v === 'static') this.i++;
    if (this.peek()?.v === 'global') this.i++;
    const first = this.readQualifiedName();
    if (this.is('=')) {
      this.i++;
      const target = this.readQualifiedName();
      this.out.usings.push(`${first}=${target}`);
    } else if (first) {
      this.out.usings.push(first);
    }
    this.skipTo(';', this.toks.length);
    this.i++;
  }

  private typeArgsAt(idx: number): { names: string[]; end: number } | undefined {
    if (this.toks[idx]?.v !== '<') return undefined;
    const close = this.matching(idx);
    if (close < 0 || close >= this.toks.length) return undefined;
    for (let k = idx + 1; k < close; k++) {
      const t = this.toks[k];
      if (t.t === 'str' || t.t === 'num') return undefined;
      if (t.t === 'p' && !['.', ',', '<', '>', '[', ']', '?', '(', ')', '::'].includes(t.v)) return undefined;
    }
    return { names: this.typeNamesIn(idx + 1, close), end: close };
  }

  /** All type names referenced in a token range (qualified names joined, generics flattened). */
  private typeNamesIn(start: number, end: number): string[] {
    const names: string[] = [];
    for (let k = start; k < end; k++) {
      const t = this.toks[k];
      if (t.t !== 'id' || KEYWORDS.has(t.v) || MODIFIERS.has(t.v)) continue;
      if (k > start && (this.toks[k - 1].v === '.' || this.toks[k - 1].v === '::')) continue;
      let name = t.v;
      while ((this.toks[k + 1]?.v === '.' || this.toks[k + 1]?.v === '::') && this.toks[k + 2]?.t === 'id' && k + 2 < end) {
        name += '.' + this.toks[k + 2].v;
        k += 2;
      }
      names.push(name);
    }
    return names;
  }

  /** Main type name of a type token sequence (e.g. "List<Foo>" -> "List", "Foo[]" -> "Foo"). */
  private mainTypeName(start: number, end: number): string | undefined {
    for (let k = start; k < end; k++) {
      const t = this.toks[k];
      if (t.t === 'id' && !MODIFIERS.has(t.v)) {
        let name = t.v;
        while ((this.toks[k + 1]?.v === '.' || this.toks[k + 1]?.v === '::') && this.toks[k + 2]?.t === 'id' && k + 2 < end) {
          name += '.' + this.toks[k + 2].v;
          k += 2;
        }
        return name;
      }
      if (t.v === '(') return undefined; // tuple
    }
    return undefined;
  }

  private addSymbol(sym: SymbolInfo): SymbolInfo {
    this.out.symbols.push(sym);
    return sym;
  }

  private ref(from: string, name: string, kind: RawReference['kind'], line: number, extra?: Partial<RawReference>): void {
    if (!name || PRIMITIVES.has(name) || KEYWORDS.has(name)) return;
    this.out.references.push({ from, name, kind, line, ...extra });
  }

  private parseType(ns: string, typeStack: TypeCtx[], attrs: string[], mods: string[], end: number): void {
    let kwTok = this.peek()!;
    let kind = kwTok.v as SymbolKind;
    this.i++;
    if (kind === 'record' && (this.is('class') || this.is('struct'))) {
      this.i++;
    }
    const nameTok = this.peek()!;
    const name = nameTok.v;
    this.i++;
    const generics = this.typeArgsAt(this.i);
    if (generics) this.i = generics.end + 1;

    const parent = typeStack[typeStack.length - 1];
    const qualified = parent ? `${parent.sym.qualifiedName}.${name}` : ns ? `${ns}.${name}` : name;
    const sym = this.addSymbol({
      id: `${this.file}#${qualified}`,
      name,
      qualifiedName: qualified,
      kind,
      language: 'csharp',
      file: this.file,
      namespace: ns || undefined,
      parent: parent?.sym.id,
      visibility: mods.find((m) => VISIBILITY.includes(m)) ?? (parent ? 'private' : 'internal'),
      modifiers: mods.filter((m) => !VISIBILITY.includes(m)),
      attributes: attrs.length ? attrs : undefined,
      baseTypes: [],
      startLine: kwTok.l,
      endLine: kwTok.l,
    });
    const ctx: TypeCtx = { sym, fields: new Map(), pendingBodies: [], memberCount: new Map(), isLifetimeScope: false };

    // Primary constructor parameters (records and C# 12 classes)
    if (this.is('(')) {
      const close = this.matching(this.i);
      const params = this.parseParams(this.i, close, sym.id);
      const ctor = this.addSymbol({
        id: `${sym.id}.${name}(${params.length})`,
        name,
        qualifiedName: `${qualified}.${name}`,
        kind: 'constructor',
        language: 'csharp',
        file: this.file,
        namespace: ns || undefined,
        parent: sym.id,
        visibility: 'public',
        parameters: params.map((x) => x.type),
        startLine: kwTok.l,
        endLine: kwTok.l,
      });
      for (const prm of params) {
        ctx.fields.set(prm.name, prm.type);
        this.ref(sym.id, prm.type, 'type', prm.line);
        for (const g of prm.allTypes) this.ref(sym.id, g, 'type', prm.line);
        if (kind === 'class') this.out.injections.push({ consumer: sym.id, type: prm.type, line: prm.line, via: 'constructor' });
      }
      void ctor;
      this.i = close + 1;
    }
    // Base list
    if (this.is(':')) {
      this.i++;
      while (this.i < end && !this.is('{') && !this.is(';') && !(this.peek()?.v === 'where' && this.peek(1)?.t === 'id' && this.peek(2)?.v === ':')) {
        const s = this.i;
        let depth = 0;
        while (this.i < end) {
          const t = this.peek()!;
          if (t.v === '<' || t.v === '(') depth++;
          else if (t.v === '>' || t.v === ')') depth--;
          else if (depth === 0 && (t.v === ',' || t.v === '{' || t.v === ';' || (t.v === 'where' && this.peek(2)?.v === ':'))) break;
          this.i++;
        }
        const baseName = this.mainTypeName(s, this.i);
        if (baseName) {
          sym.baseTypes!.push(baseName);
          this.ref(sym.id, baseName, 'inherit', this.toks[s].l);
          const parenAt = this.toks.slice(s, this.i).findIndex((x) => x.v === '(');
          const typeEnd = parenAt >= 0 ? s + parenAt : this.i;
          for (const g of this.typeNamesIn(s, typeEnd).slice(1)) this.ref(sym.id, g, 'type', this.toks[s].l);
          if (/LifetimeScope$|MonoInstaller$|Installer$|ScriptableObjectInstaller$/.test(baseName)) ctx.isLifetimeScope = true;
        }
        if (this.is(',')) this.i++;
      }
    }
    // Generic constraints
    while (this.peek()?.v === 'where') {
      this.skipUntilAny(['{', ';', 'where'], end, true);
    }
    if (this.is(';')) {
      sym.endLine = this.peek()!.l;
      this.i++;
      return;
    }
    if (!this.is('{')) {
      this.skipTo(';', end);
      this.i++;
      return;
    }
    const close = this.matching(this.i);
    if (kind === 'enum') {
      sym.endLine = this.toks[Math.min(close, this.toks.length - 1)].l;
      this.i = close + 1;
      return;
    }
    this.i++;
    typeStack.push(ctx);
    this.parseScope(ns, typeStack, close);
    typeStack.pop();
    sym.endLine = this.toks[Math.min(close, this.toks.length - 1)]?.l ?? sym.startLine;
    this.i = close + 1;
    // Bodies are processed once all fields are known so member-access calls can be typed.
    for (const b of ctx.pendingBodies) this.scanBody(ctx, b.owner, b.start, b.end, b.locals);
    if (this.is(';')) this.i++;
  }

  private skipUntilAny(stops: string[], end: number, skipFirst: boolean): void {
    if (skipFirst) this.i++;
    while (this.i < end && !stops.includes(this.peek()!.v)) {
      if (this.is('(') || this.is('[')) this.i = this.matching(this.i);
      this.i++;
    }
  }

  private parseDelegate(ns: string, typeStack: TypeCtx[], mods: string[]): void {
    const start = this.i;
    this.skipTo(';', this.toks.length);
    // delegate <ret> Name<...>(...);
    const paren = this.toks.slice(start, this.i).findIndex((t) => t.v === '(');
    if (paren > 0) {
      let k = start + paren - 1;
      if (this.toks[k].v === '>') {
        let depth = 0;
        for (; k > start; k--) {
          if (this.toks[k].v === '>') depth++;
          else if (this.toks[k].v === '<') {
            depth--;
            if (depth === 0) break;
          }
        }
        k--;
      }
      const name = this.toks[k]?.v;
      const parent = typeStack[typeStack.length - 1];
      if (name) {
        const q = parent ? `${parent.sym.qualifiedName}.${name}` : ns ? `${ns}.${name}` : name;
        this.addSymbol({
          id: `${this.file}#${q}`,
          name,
          qualifiedName: q,
          kind: 'type',
          language: 'csharp',
          file: this.file,
          namespace: ns || undefined,
          parent: parent?.sym.id,
          visibility: mods.find((m) => VISIBILITY.includes(m)) ?? 'internal',
          modifiers: ['delegate'],
          startLine: this.toks[start].l,
          endLine: this.toks[start].l,
        });
      }
    }
    this.i++;
  }

  private parseParams(open: number, close: number, owner: string): { name: string; type: string; allTypes: string[]; line: number; attrs: string[] }[] {
    const params: { name: string; type: string; allTypes: string[]; line: number; attrs: string[] }[] = [];
    let k = open + 1;
    while (k < close) {
      // one parameter: [attrs] [mods] Type name [= default]
      const attrs: string[] = [];
      while (this.toks[k]?.v === '[') {
        const e = this.matching(k);
        if (this.toks[k + 1]?.t === 'id') attrs.push(this.toks[k + 1].v);
        k = e + 1;
      }
      const s = k;
      let depth = 0;
      let eq = -1;
      while (k < close) {
        const t = this.toks[k];
        if (t.v === '<' || t.v === '(' || t.v === '[') depth++;
        else if (t.v === '>' || t.v === ')' || t.v === ']') depth--;
        else if (depth === 0 && t.v === ',') break;
        else if (depth === 0 && t.v === '=' && eq < 0) eq = k;
        k++;
      }
      const declEnd = eq >= 0 ? eq : k;
      let typeStart = s;
      while (typeStart < declEnd && ['this', 'ref', 'out', 'in', 'params', 'scoped', 'readonly'].includes(this.toks[typeStart].v)) typeStart++;
      const nameTok = this.toks[declEnd - 1];
      if (nameTok?.t === 'id' && declEnd - 1 > typeStart) {
        const type = this.mainTypeName(typeStart, declEnd - 1);
        if (type) {
          params.push({ name: nameTok.v, type, allTypes: this.typeNamesIn(typeStart, declEnd - 1).filter((x) => x !== type), line: nameTok.l, attrs });
        }
      }
      k++; // skip comma
    }
    void owner;
    return params;
  }

  private memberId(ctx: TypeCtx, name: string, arity?: number): string {
    const base = arity === undefined ? `${ctx.sym.id}.${name}` : `${ctx.sym.id}.${name}(${arity})`;
    const count = (ctx.memberCount.get(base) ?? 0) + 1;
    ctx.memberCount.set(base, count);
    return count > 1 ? `${base}~${count}` : base;
  }

  private parseMember(ctx: TypeCtx, attrs: string[], mods: string[], end: number): void {
    const hs = this.i;
    let depth = 0;
    let firstParen = -1;
    let stop = -1;
    while (this.i < end) {
      const t = this.peek()!;
      if (t.t === 'p') {
        if (t.v === '(' || t.v === '[') {
          if (depth === 0 && t.v === '(' && firstParen < 0) {
            const prev = this.toks[this.i - 1];
            if (this.i > hs && (prev.t === 'id' || prev.v === '>') && !MODIFIERS.has(prev.v)) firstParen = this.i;
          }
          depth++;
        } else if (t.v === ')' || t.v === ']') depth--;
        else if (depth === 0 && (t.v === '{' || t.v === ';' || t.v === '=>' || t.v === '=' || t.v === '}')) {
          stop = this.i;
          break;
        }
      }
      this.i++;
    }
    if (stop < 0 || this.peek()?.v === '}') {
      if (this.i === hs) this.i++;
      return;
    }
    const stopTok = this.toks[stop];
    const line = this.toks[hs]?.l ?? stopTok.l;
    const isEvent = mods.includes('event');

    if (firstParen >= 0) {
      // ---- method / constructor / operator ----
      const closeParen = this.matching(firstParen);
      let nameIdx = firstParen - 1;
      let isGenericMethod = false;
      if (this.toks[nameIdx].v === '>') {
        let d = 0;
        for (; nameIdx > hs; nameIdx--) {
          if (this.toks[nameIdx].v === '>') d++;
          else if (this.toks[nameIdx].v === '<') {
            d--;
            if (d === 0) break;
          }
        }
        nameIdx--;
        isGenericMethod = true;
      }
      let name = this.toks[nameIdx]?.v ?? '?';
      if (this.toks[nameIdx - 1]?.v === 'operator') name = `operator ${name}`;
      // explicit interface implementation: IFoo.Bar(
      let explicitIface: string | undefined;
      if (this.toks[nameIdx - 1]?.v === '.' && this.toks[nameIdx - 2]?.t === 'id') {
        explicitIface = this.toks[nameIdx - 2].v;
      }
      const retStart = hs;
      const retEnd = explicitIface ? nameIdx - 2 : this.toks[nameIdx - 1]?.v === 'operator' ? nameIdx - 1 : nameIdx;
      const isCtor = name === ctx.sym.name && retEnd === retStart;
      const isFinalizer = this.toks[nameIdx - 1]?.v === '~';
      const params = this.parseParams(firstParen, closeParen, ctx.sym.id);
      const kind: SymbolKind = isCtor ? 'constructor' : 'method';
      const returnType = isCtor ? undefined : this.mainTypeName(retStart, retEnd);
      const sym = this.addSymbol({
        id: this.memberId(ctx, isFinalizer ? `~${name}` : name, params.length),
        name: isFinalizer ? `~${name}` : name,
        qualifiedName: `${ctx.sym.qualifiedName}.${name}`,
        kind,
        language: 'csharp',
        file: this.file,
        namespace: ctx.sym.namespace,
        parent: ctx.sym.id,
        visibility: mods.find((m) => VISIBILITY.includes(m)) ?? (ctx.sym.kind === 'interface' ? 'public' : 'private'),
        modifiers: [...mods.filter((m) => !VISIBILITY.includes(m)), ...(isGenericMethod ? ['generic'] : [])],
        attributes: attrs.length ? attrs : undefined,
        parameters: params.map((x) => x.type),
        returnType,
        startLine: line,
        endLine: line,
      });
      if (returnType) this.ref(sym.id, returnType, 'type', line);
      for (const g of this.typeNamesIn(retStart, retEnd)) if (g !== returnType) this.ref(sym.id, g, 'type', line);
      const locals = new Map<string, string>();
      for (const prm of params) {
        locals.set(prm.name, prm.type);
        this.ref(isCtor ? ctx.sym.id : sym.id, prm.type, 'type', prm.line);
        for (const g of prm.allTypes) this.ref(sym.id, g, 'type', prm.line);
      }
      if (isCtor && ctx.sym.kind !== 'struct' && !mods.includes('static')) {
        for (const prm of params) this.out.injections.push({ consumer: ctx.sym.id, type: prm.type, line: prm.line, via: 'constructor' });
      }
      if (attrs.includes('Inject')) {
        for (const prm of params) this.out.injections.push({ consumer: ctx.sym.id, type: prm.type, line: prm.line, via: 'method' });
      }
      // Body: skip to '{' or '=>' or ';' (ctor initializers / where clauses in between)
      this.i = closeParen + 1;
      let initStart = -1;
      while (this.i < end && !this.is('{') && !this.is('=>') && !this.is(';')) {
        if (this.is(':') && initStart < 0) initStart = this.i;
        if (this.is('(')) this.i = this.matching(this.i);
        this.i++;
      }
      if (initStart >= 0) {
        ctx.pendingBodies.push({ owner: sym, start: initStart + 1, end: this.i, locals });
      }
      this.finishBody(ctx, sym, locals, end);
      return;
    }

    // ---- property / field / event / indexer ----
    const isIndexer = this.toks.slice(hs, stop).some((t) => t.v === 'this') && this.toks.slice(hs, stop).some((t) => t.v === '[');
    // Field declarators: Type a = x, b = y;
    let nameIdx = stop - 1;
    if (isIndexer) {
      nameIdx = this.toks.slice(hs, stop).findIndex((t) => t.v === 'this') + hs;
    }
    let explicitIfaceEnd = nameIdx;
    if (this.toks[nameIdx - 1]?.v === '.' && this.toks[nameIdx - 2]?.t === 'id') explicitIfaceEnd = nameIdx - 2;
    const nameTok = this.toks[nameIdx];
    if (!nameTok || nameTok.t !== 'id' || nameIdx <= hs) {
      // unknown construct; skip
      this.i = stop;
      this.skipTo(';', end);
      if (this.is(';')) this.i++;
      return;
    }
    const typeName = this.mainTypeName(hs, explicitIfaceEnd);
    const allTypes = this.typeNamesIn(hs, explicitIfaceEnd);
    const isProperty = stopTok.v === '{' || stopTok.v === '=>';
    const isConst = mods.includes('const');
    const kind: SymbolKind = isProperty ? 'property' : 'field';
    const declare = (nm: string, l: number): SymbolInfo => {
      const s = this.addSymbol({
        id: this.memberId(ctx, isIndexer ? 'this[]' : nm),
        name: isIndexer ? 'this[]' : nm,
        qualifiedName: `${ctx.sym.qualifiedName}.${nm}`,
        kind,
        language: 'csharp',
        file: this.file,
        namespace: ctx.sym.namespace,
        parent: ctx.sym.id,
        visibility: mods.find((m) => VISIBILITY.includes(m)) ?? (ctx.sym.kind === 'interface' ? 'public' : 'private'),
        modifiers: [...mods.filter((m) => !VISIBILITY.includes(m)), ...(isEvent ? ['event'] : [])],
        attributes: attrs.length ? attrs : undefined,
        returnType: typeName,
        startLine: l,
        endLine: l,
      });
      if (typeName) ctx.fields.set(nm, typeName);
      // Structural dependencies are recorded on the type (fields/properties define what a class needs).
      if (!isConst) for (const tn of allTypes) this.ref(ctx.sym.id, tn, 'type', l);
      if (attrs.includes('Inject') && typeName) this.out.injections.push({ consumer: ctx.sym.id, type: typeName, line: l, via: 'attribute' });
      return s;
    };
    const first = declare(nameTok.v, nameTok.l);
    this.i = stop;
    if (stopTok.v === '{') {
      const close = this.matching(this.i);
      ctx.pendingBodies.push({ owner: first, start: this.i + 1, end: close, locals: new Map() });
      first.endLine = this.toks[close]?.l ?? first.endLine;
      this.i = close + 1;
      if (this.is('=')) {
        const s = this.i + 1;
        this.skipTo(';', end);
        ctx.pendingBodies.push({ owner: first, start: s, end: this.i, locals: new Map() });
      }
      if (this.is(';')) this.i++;
      return;
    }
    if (stopTok.v === '=>') {
      const s = this.i + 1;
      this.skipTo(';', end);
      ctx.pendingBodies.push({ owner: first, start: s, end: this.i, locals: new Map() });
      first.endLine = this.peek()?.l ?? first.endLine;
      this.i++;
      return;
    }
    // field: '=' initializer and/or further declarators
    while (this.i < end && !this.is(';')) {
      if (this.is('=')) {
        const s = this.i + 1;
        let d = 0;
        this.i++;
        while (this.i < end) {
          const t = this.peek()!;
          if (t.v === '(' || t.v === '{' || t.v === '[') d++;
          else if (t.v === ')' || t.v === '}' || t.v === ']') d--;
          else if (d === 0 && (t.v === ',' || t.v === ';')) break;
          this.i++;
        }
        ctx.pendingBodies.push({ owner: first, start: s, end: this.i, locals: new Map() });
      } else if (this.is(',')) {
        this.i++;
        if (this.peek()?.t === 'id') {
          declare(this.peek()!.v, this.peek()!.l);
          this.i++;
        }
      } else {
        this.i++;
      }
    }
    this.i++;
  }

  private finishBody(ctx: TypeCtx, sym: SymbolInfo, locals: Map<string, string>, end: number): void {
    if (this.is('{')) {
      const close = this.matching(this.i);
      ctx.pendingBodies.push({ owner: sym, start: this.i + 1, end: close, locals });
      sym.endLine = this.toks[close]?.l ?? sym.endLine;
      this.i = close + 1;
    } else if (this.is('=>')) {
      const s = this.i + 1;
      this.skipTo(';', end);
      ctx.pendingBodies.push({ owner: sym, start: s, end: this.i, locals });
      sym.endLine = this.peek()?.l ?? sym.endLine;
      this.i++;
    } else if (this.is(';')) {
      this.i++;
    }
  }

  // -------------------------------------------------------------------------
  // Body scanning: calls, object creation, type usage, events, DI registrations
  // -------------------------------------------------------------------------

  private scanBody(ctx: TypeCtx, owner: SymbolInfo, start: number, end: number, locals: Map<string, string>): void {
    const T = this.toks;
    const seenTypes = new Set<string>();
    const norm: string[] = [];
    const typeOf = (name: string): string | undefined => {
      if (name === 'this') return ctx.sym.name;
      return locals.get(name) ?? ctx.fields.get(name);
    };

    for (let k = start; k < end; k++) {
      const t = T[k];
      // normalized token stream for duplicate detection
      if (t.t === 'id') norm.push(locals.has(t.v) ? '$v' : t.v);
      else if (t.t === 'str' || t.t === 'num') norm.push('$lit');
      else norm.push(t.v);

      if (t.t !== 'id') {
        if (t.v === '+=' || t.v === '-=') this.scanEventSub(ctx, owner, k, typeOf);
        continue;
      }

      // local declarations:  Type name =|;|in   /   var name = new Type(
      if (!KEYWORDS.has(t.v) || t.v === 'var') {
        const nx = T[k + 1];
        let afterType = k + 1;
        const ga = this.typeArgsAt(k + 1);
        if (ga) afterType = ga.end + 1;
        while (T[afterType]?.v === '[' && T[afterType + 1]?.v === ']') afterType += 2;
        if (T[afterType]?.v === '?') afterType++;
        const nameT = T[afterType];
        const follow = T[afterType + 1];
        if (nameT?.t === 'id' && !KEYWORDS.has(nameT.v) && follow && ['=', ';', 'in', ',', ')'].includes(follow.v) && (T[k - 1]?.v !== '.' ) && nx) {
          if (t.v === 'var') {
            if (follow.v === '=' && T[afterType + 2]?.v === 'new' && T[afterType + 3]?.t === 'id') locals.set(nameT.v, T[afterType + 3].v);
            else if (follow.v === '=' && T[afterType + 2]?.t === 'id') {
              // var x = a.B.C;  → remember the member chain so x.Method() can be resolved later
              const chain: string[] = [];
              let j = afterType + 2;
              while (T[j]?.t === 'id') {
                chain.push(T[j].v);
                if ((T[j + 1]?.v === '.' || T[j + 1]?.v === '?.') && T[j + 2]?.t === 'id') j += 2;
                else break;
              }
              if (T[j + 1]?.v === ';' && chain.length) {
                const ct = this.chainType(ctx, chain, typeOf);
                if (ct) locals.set(nameT.v, ct);
              }
            }
          } else if (/^[A-Z_]/.test(t.v) || PRIMITIVES.has(t.v)) {
            locals.set(nameT.v, t.v);
          }
        }
      }

      if (t.v === 'new') {
        const nt = T[k + 1];
        if (nt?.t === 'id' && !PRIMITIVES.has(nt.v)) {
          let name = nt.v;
          let j = k + 1;
          while (T[j + 1]?.v === '.' && T[j + 2]?.t === 'id') {
            name += '.' + T[j + 2].v;
            j += 2;
          }
          this.ref(owner.id, name, 'new', t.l);
          const ga = this.typeArgsAt(j + 1);
          if (ga) for (const g of ga.names) this.ref(owner.id, g, 'type', t.l);
          seenTypes.add(name);
        }
        continue;
      }

      if (KEYWORDS.has(t.v)) {
        if ((t.v === 'typeof' || t.v === 'nameof' || t.v === 'is' || t.v === 'as') && T[k + 1]) {
          const j = T[k + 1].v === '(' ? k + 2 : k + 1;
          if (T[j]?.t === 'id' && /^[A-Z]/.test(T[j].v) && !seenTypes.has(T[j].v)) {
            seenTypes.add(T[j].v);
            this.ref(owner.id, T[j].v, 'type', t.l);
          }
        }
        continue;
      }

      // call detection: Name(  or  Name<T>(
      let callEnd = k + 1;
      const ga = this.typeArgsAt(k + 1);
      if (ga) callEnd = ga.end + 1;
      const isCall = T[callEnd]?.v === '(';
      const prev = T[k - 1];
      const memberAccess = prev && (prev.v === '.' || prev.v === '?.');

      if (isCall) {
        const arity = this.countArgs(callEnd);
        if (memberAccess) {
          // receiver: identifier (or this) directly before the dot
          const recv = T[k - 2];
          let receiverType: string | undefined;
          if (recv?.t === 'id') {
            // a.B.C.Method(  → chain type "@TypeOfA|B|C", resolved across files by the resolver
            receiverType = this.receiverChainType(ctx, k, start, typeOf);
          } else if (recv?.v === ')') {
            // new Foo(...).Bar(   /   GetComponent<Foo>().Bar(
            let d = 0;
            let open = k - 2;
            for (; open > start; open--) {
              if (T[open].v === ')') d++;
              else if (T[open].v === '(') {
                d--;
                if (d === 0) break;
              }
            }
            const before = T[open - 1];
            if (before?.t === 'id' && T[open - 2]?.v === 'new') receiverType = before.v;
            else if (before?.v === '>') {
              let g = open - 1;
              while (g > start && T[g].v !== '<') g--;
              if (T[g + 1]?.t === 'id' && /^(GetComponent|GetComponentInChildren|GetComponentInParent|FindObjectOfType|FindAnyObjectByType|Resolve|Get|AddComponent|Instantiate|Load)$/.test(T[g - 1]?.v ?? '')) {
                receiverType = T[g + 1].v;
              }
            }
          }
          this.ref(owner.id, t.v, 'member-call', t.l, { receiverType, arity });
          if (t.v === 'Invoke' && recv?.t === 'id') this.ref(owner.id, recv.v, 'event-pub', t.l, { receiverType: ctx.sym.name });
          if ((t.v === 'Publish' || t.v === 'OnNext' || t.v === 'Fire' || t.v === 'Raise' || t.v === 'Dispatch' || t.v === 'Emit') && receiverType) {
            this.ref(owner.id, receiverType, 'event-pub', t.l);
          }
          if (t.v === 'Subscribe' && receiverType) this.ref(owner.id, receiverType, 'event-sub', t.l);
        } else {
          this.ref(owner.id, t.v, 'call', t.l, { receiverType: ctx.sym.name, arity });
        }
        if (ga) for (const g of ga.names) if (!seenTypes.has(g)) {
          seenTypes.add(g);
          this.ref(owner.id, g, 'type', t.l);
        }
        this.detectDI(ctx, owner, k, callEnd, ga?.names ?? [], typeOf);
        continue;
      }

      // Method group passed as a delegate: AddListener(OnClick), x.Event += Handler, Func<int> f = Compute;
      if (/^[A-Z]/.test(t.v) && !locals.has(t.v) && !ctx.fields.has(t.v) && [')', ',', ';'].includes(T[k + 1]?.v ?? '') &&
        (!memberAccess || T[k - 2]?.v === 'this')) {
        this.ref(owner.id, t.v, 'call', t.l, { receiverType: ctx.sym.name });
      }
      // Static member access or type usage: Foo.Bar / Foo<T>
      if (!memberAccess && /^[A-Z]/.test(t.v) && !locals.has(t.v) && !ctx.fields.has(t.v) && !seenTypes.has(t.v)) {
        if (T[k + 1]?.v === '.' || ga || T[k + 1]?.t === 'id') {
          seenTypes.add(t.v);
          this.ref(owner.id, t.v, 'type', t.l);
          if (ga) for (const g of ga.names) this.ref(owner.id, g, 'type', t.l);
        }
      }
    }
    const fp = fingerprint(norm);
    if (fp && (owner.kind === 'method' || owner.kind === 'constructor')) {
      this.out.methodFingerprints.push({ id: owner.id, tokens: norm.length, shingles: fp });
    }
  }

  private scanEventSub(ctx: TypeCtx, owner: SymbolInfo, opIdx: number, typeOf: (n: string) => string | undefined): void {
    const T = this.toks;
    // x.Event += Handler   or   Event += Handler
    const evTok = T[opIdx - 1];
    if (evTok?.t !== 'id') return;
    const rhs = T[opIdx + 1];
    // only treat as event subscription when the rhs is a method group or lambda
    const looksHandler = rhs && (rhs.t === 'id' && !/^\d/.test(rhs.v) && (T[opIdx + 2]?.v === ';' || T[opIdx + 2]?.v === '=>' || T[opIdx + 2]?.v === '.')) || rhs?.v === '(' || rhs?.v === 'delegate';
    if (!looksHandler) return;
    if (T[opIdx + 2]?.v === ';' && rhs.t === 'id' && typeOf(rhs.v) && ['int', 'float', 'double', 'long'].includes(typeOf(rhs.v)!)) return;
    let receiverType: string | undefined;
    if (T[opIdx - 2]?.v === '.' && T[opIdx - 3]?.t === 'id') {
      const r = T[opIdx - 3].v;
      receiverType = typeOf(r) ?? (/^[A-Z]/.test(r) ? r : undefined);
    } else {
      receiverType = ctx.sym.name;
    }
    this.ref(owner.id, evTok.v, 'event-sub', evTok.l, { receiverType });
  }

  private countArgs(openIdx: number): number {
    const close = this.matching(openIdx);
    if (close === openIdx + 1) return 0;
    let n = 1;
    let d = 0;
    for (let k = openIdx + 1; k < close; k++) {
      const v = this.toks[k].v;
      if (v === '(' || v === '[' || v === '{' || v === '<') d++;
      else if (v === ')' || v === ']' || v === '}' || v === '>') d--;
      else if (v === ',' && d === 0) n++;
    }
    return n;
  }

  /** Type of a member-access chain like ["this","_a","B"] → "@Self|_a|B" (single element → its plain type). */
  private chainType(ctx: TypeCtx, chain: string[], typeOf: (n: string) => string | undefined): string | undefined {
    const first = chain[0];
    let t: string | undefined;
    let rest = chain.slice(1);
    if (first === 'this') {
      if (!rest.length) return ctx.sym.name;
      t = typeOf(rest[0]) ?? `@${ctx.sym.name}|${rest[0]}`;
      rest = rest.slice(1);
    } else if (first === 'base') t = ctx.sym.baseTypes?.[0];
    else t = typeOf(first) ?? (/^[A-Z]/.test(first) ? first : undefined); // uppercase: static type, or an inherited property (resolver decides)
    // Unknown simple identifiers inside the type are likely inherited members: resolve via the type itself.
    if (!t && /^[A-Za-z_]/.test(first) && !/^[A-Z]/.test(first)) t = `@${ctx.sym.name}|${first}`;
    if (!t) return undefined;
    if (!rest.length) return t;
    return (t.startsWith('@') ? t : '@' + t) + '|' + rest.join('|');
  }

  /** Receiver type for the member token at index k (preceded by "." or "?."). */
  private receiverChainType(ctx: TypeCtx, k: number, start: number, typeOf: (n: string) => string | undefined): string | undefined {
    const T = this.toks;
    const chain: string[] = [];
    let j = k - 2;
    while (j >= start && T[j]?.t === 'id') {
      chain.unshift(T[j].v);
      if ((T[j - 1]?.v === '.' || T[j - 1]?.v === '?.') && j - 2 >= start) {
        if (T[j - 2]?.t !== 'id') return undefined; // call/indexer in the middle of the chain
        j -= 2;
      } else break;
    }
    if (!chain.length || chain.length > 6) return undefined;
    return this.chainType(ctx, chain, typeOf);
  }

  private detectDI(ctx: TypeCtx, owner: SymbolInfo, k: number, callEnd: number, typeArgs: string[], typeOf: (n: string) => string | undefined): void {
    const T = this.toks;
    const m = T[k].v;
    const line = T[k].l;
    const push = (container: string, service: string, impl: string, method: string, lifetime?: string): void => {
      this.out.di.push({ file: this.file, line, container, scopeSymbol: ctx.sym.id, service, implementation: impl, lifetime, method });
    };
    const stmtEnd = (): number => {
      let j = callEnd;
      let d = 0;
      while (j < T.length) {
        const v = T[j].v;
        if (v === '(' || v === '{' || v === '[') d++;
        else if (v === ')' || v === '}' || v === ']') {
          d--;
          if (d < 0) break;
        } else if (v === ';' && d === 0) break;
        j++;
      }
      return j;
    };
    const lifetimeIn = (s: number, e: number): string | undefined => {
      for (let j = s; j < e; j++) if (T[j].v === 'Lifetime' && T[j + 1]?.v === '.' && T[j + 2]) return T[j + 2].v;
      return undefined;
    };
    const asTypes = (s: number, e: number): { types: string[]; implementedInterfaces: boolean; self: boolean } => {
      const types: string[] = [];
      let implementedInterfaces = false;
      let self = false;
      for (let j = s; j < e; j++) {
        if (T[j].v === 'As' && T[j - 1]?.v === '.') {
          const ga = this.typeArgsAt(j + 1);
          if (ga) types.push(...ga.names);
          else if (T[j + 1]?.v === '(') {
            for (let q = j + 2; q < this.matching(j + 1); q++) if (T[q].v === 'typeof' && T[q + 2]?.t === 'id') types.push(T[q + 2].v);
          }
        }
        if (T[j].v === 'AsImplementedInterfaces') implementedInterfaces = true;
        if (T[j].v === 'AsSelf') self = true;
      }
      return { types, implementedInterfaces, self };
    };

    // ---- VContainer ----
    if (/^Register(EntryPoint|Component|ComponentInHierarchy|ComponentOnNewGameObject|ComponentInNewPrefab|Instance|Factory)?$/.test(m) &&
      (ctx.isLifetimeScope || (T[k - 1]?.v === '.' && /builder/i.test(T[k - 2]?.v ?? '')))) {
      const e = stmtEnd();
      const lifetime = lifetimeIn(callEnd, e) ?? (m === 'RegisterEntryPoint' ? 'Singleton' : undefined);
      let impl: string | undefined = typeArgs[typeArgs.length - 1];
      if (!impl && (m === 'RegisterComponent' || m === 'RegisterInstance')) {
        // RegisterComponent(field) — use the argument's declared type
        // RegisterComponent(a.B.C) — member chain resolved across files by the resolver
        const chain: string[] = [];
        let j = callEnd + 1;
        while (T[j]?.t === 'id') {
          chain.push(T[j].v);
          if ((T[j + 1]?.v === '.' || T[j + 1]?.v === '?.') && T[j + 2]?.t === 'id') j += 2;
          else break;
        }
        if (chain.length && T[j + 1]?.v === ')') impl = this.chainType(ctx, chain, typeOf);
      }
      if (!impl) return;
      const as = asTypes(callEnd, e);
      const services = new Set<string>();
      if (typeArgs.length >= 2) services.add(typeArgs[0]);
      for (const s of as.types) services.add(s);
      if (as.implementedInterfaces) services.add('*interfaces*');
      if (services.size === 0 || as.self) services.add(impl);
      for (const s of services) push('VContainer', s, impl, m, lifetime);
      return;
    }
    // ---- Zenject / Extenject ----
    if (/^(Bind|BindInterfacesTo|BindInterfacesAndSelfTo|BindFactory|BindInstance)$/.test(m) && (T[k - 2]?.v === 'Container' || ctx.isLifetimeScope)) {
      const e = stmtEnd();
      let lifetime: string | undefined;
      let impl: string | undefined;
      for (let j = callEnd; j < e; j++) {
        if (['AsSingle', 'AsTransient', 'AsCached'].includes(T[j].v)) lifetime = T[j].v.slice(2);
        if ((T[j].v === 'To' || T[j].v === 'FromComponentInNewPrefab') && T[j - 1]?.v === '.') {
          const ga = this.typeArgsAt(j + 1);
          if (ga) impl = ga.names[0];
        }
      }
      if (m === 'BindInterfacesTo' || m === 'BindInterfacesAndSelfTo') {
        const target = typeArgs[0];
        if (target) {
          push('Zenject', '*interfaces*', target, m, lifetime);
          if (m === 'BindInterfacesAndSelfTo') push('Zenject', target, target, m, lifetime);
        }
        return;
      }
      const svc = typeArgs[0];
      if (svc) push('Zenject', svc, impl ?? svc, m, lifetime);
      return;
    }
    // ---- Microsoft.Extensions.DependencyInjection ----
    const ms = /^(?:Add|TryAdd)(Singleton|Scoped|Transient|HostedService)$/.exec(m);
    if (ms && typeArgs.length) {
      push('MS.DI', typeArgs[0], typeArgs[typeArgs.length - 1], m, ms[1]);
    }
  }
}
