import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfo, SymbolInfo, TYPE_KINDS } from '../model/types';
import { GraphIndex, ImpactReport, splitWords } from '../analysis/graph';
import { FeatureFlow, relevance } from '../analysis/features';
import { ChatTurn } from './provider';

// Evidence-based prompting: the model only sees facts produced by static analysis plus
// the source snippets we choose, and must cite them.

export const SYSTEM_PROMPT = `You are an architecture analyst embedded in a code-understanding tool.
You receive FACTS extracted by deterministic static analysis (symbols, relationships, DI registrations, layers, modules) and selected SOURCE SNIPPETS.

Rules:
- Base every statement on the provided facts or snippets. If something is not in the context, say you cannot see it rather than guessing.
- Back conclusions with evidence ("X appears to coordinate farming because 6 actions call it and it depends on A, B, C").
- Cite code with markdown links whose target is "path:line", e.g. [FarmManager](Assets/Game/Farming/FarmManager.cs:12). Use the exact paths given.
- When you infer intent ("why this exists"), label it as an inference and give a confidence (low / medium / high).
- Write for a developer who is new to this codebase. Be concise and structured; prefer short sections and bullet lists over long prose.`;

const MAX_SNIPPET_LINES = 140;

export class ContextBuilder {
  constructor(private readonly graph: GraphIndex, private readonly root: string) {}

  private loc(s: SymbolInfo): string {
    return `${s.file}:${s.startLine}`;
  }

  private label(s: SymbolInfo): string {
    return `${s.name} [${s.kind}${s.layer ? `, ${s.layer}` : ''}] (${this.loc(s)})`;
  }

  snippet(s: SymbolInfo, maxLines = MAX_SNIPPET_LINES): string {
    try {
      const lines = fs.readFileSync(path.join(this.root, s.file), 'utf8').split(/\r?\n/);
      const start = Math.max(0, s.startLine - 1);
      const end = Math.min(lines.length, Math.max(s.endLine, s.startLine), start + maxLines);
      const body = lines.slice(start, end).join('\n');
      const more = s.endLine - s.startLine + 1 > maxLines ? `\n// … ${s.endLine - start - maxLines} more lines` : '';
      return `// ${s.file}:${s.startLine}-${end}\n${body}${more}`;
    } catch {
      return `// (source unavailable for ${s.file})`;
    }
  }

  projectSummary(): string {
    const m = this.graph.model;
    const p = m.project;
    const lines: string[] = [];
    lines.push(`PROJECT: ${p.name}`);
    lines.push(`Languages: ${Object.entries(p.languages).map(([k, v]) => `${k} (${v} files)`).join(', ')}`);
    if (p.frameworks.length) lines.push(`Frameworks: ${p.frameworks.join(', ')}`);
    lines.push(`Size: ${m.stats.types} types, ${m.stats.methods} methods, ${m.stats.relationships} relationships`);
    lines.push('\nDETECTED PATTERNS (deterministic heuristics):');
    for (const pt of m.patterns) lines.push(`- ${pt.name} [${pt.category}] confidence ${Math.round(pt.confidence * 100)}% — ${pt.evidence.join('; ')}`);
    lines.push('\nLAYERS:');
    for (const l of m.layers) lines.push(`- ${l.name}: ${l.symbols} types (${l.evidence.join('; ')})`);
    if (m.di.registrations.length) {
      lines.push(`\nDEPENDENCY INJECTION: ${m.di.containers.join(', ')}; ${m.di.registrations.length} registrations, ${m.di.injections.length} injection points`);
    }
    return lines.join('\n');
  }

  moduleSummary(mod: ModuleInfo, detailed: boolean): string {
    const g = this.graph;
    const lines: string[] = [];
    const deps = Object.entries(mod.dependsOn).sort((a, b) => b[1] - a[1]);
    const usedBy = g.model.modules.filter((m) => m.dependsOn[mod.id]).map((m) => `${m.name} (${m.dependsOn[mod.id]})`);
    lines.push(`MODULE ${mod.name} (folder ${mod.path}) — ${mod.files.length} files, ${mod.symbols.length} top-level symbols, layer: ${mod.layer ?? 'unknown'}`);
    lines.push(`  depends on: ${deps.map(([id, n]) => `${g.moduleById.get(id)?.name ?? id} (${n})`).join(', ') || 'nothing'}`);
    lines.push(`  used by: ${usedBy.join(', ') || 'nothing'}`);
    if (detailed) {
      const syms = mod.symbols.map((id) => g.get(id)).filter((s): s is SymbolInfo => !!s);
      const ranked = syms.map((s) => ({ s, n: g.dependents(s.id).length })).sort((a, b) => b.n - a.n);
      lines.push('  key symbols (by number of dependents):');
      for (const { s, n } of ranked.slice(0, 25)) {
        const methods = (g.children.get(s.id) ?? []).filter((c) => c.kind === 'method').map((c) => c.name);
        lines.push(`  - ${this.label(s)} · ${n} dependents · bases: ${s.baseTypes?.join(', ') || '-'} · methods: ${methods.slice(0, 10).join(', ')}${methods.length > 10 ? ', …' : ''}`);
      }
    }
    return lines.join('\n');
  }

  symbolFacts(s: SymbolInfo): string {
    const g = this.graph;
    const lines: string[] = [];
    lines.push(`SYMBOL ${s.qualifiedName}`);
    lines.push(`kind: ${s.kind}; language: ${s.language}; file: ${this.loc(s)}; lines ${s.startLine}-${s.endLine}`);
    if (s.layer) lines.push(`layer: ${s.layer}`);
    if (s.module) lines.push(`module: ${g.moduleById.get(s.module)?.name ?? s.module}`);
    if (s.baseTypes?.length) lines.push(`base types: ${s.baseTypes.join(', ')}`);
    if (s.attributes?.length) lines.push(`attributes/decorators: ${s.attributes.join(', ')}`);
    const members = g.children.get(s.id) ?? [];
    if (members.length) {
      lines.push('members:');
      for (const m of members.slice(0, 60)) lines.push(`  - ${m.visibility ?? ''} ${m.kind} ${m.name}${m.parameters ? `(${m.parameters.join(', ')})` : ''}${m.returnType ? `: ${m.returnType}` : ''} (line ${m.startLine})`);
    }
    const deps = g.dependencies(s.id);
    lines.push(`depends on (${deps.length}):`);
    for (const d of deps.slice(0, 40)) lines.push(`  → ${this.label(d.symbol)} via ${d.types.join('/')}`);
    const users = g.dependents(s.id);
    lines.push(`used by (${users.length}):`);
    for (const d of users.slice(0, 40)) lines.push(`  ← ${this.label(d.symbol)} via ${d.types.join('/')}`);
    // calls in/out of members
    const callsOut = new Set<string>();
    const callsIn = new Set<string>();
    for (const m of g.selfAndMembers(s.id)) {
      for (const r of g.callees(m.id)) {
        const t = g.get(r.target);
        if (t && g.ownerType(t).id !== s.id) callsOut.add(`${m.name} → ${t.qualifiedName.split('.').slice(-2).join('.')}`);
      }
      for (const r of g.callers(m.id)) {
        const c = g.get(r.source);
        if (c && g.ownerType(c).id !== s.id) callsIn.add(`${c.qualifiedName.split('.').slice(-2).join('.')} → ${m.name} (${r.location?.file}:${r.location?.line})`);
      }
    }
    if (callsOut.size) lines.push(`outgoing calls: ${[...callsOut].slice(0, 30).join('; ')}`);
    if (callsIn.size) lines.push(`incoming calls: ${[...callsIn].slice(0, 30).join('; ')}`);
    const di = g.model.di;
    const regs = di.registrations.filter((r) => r.implementationId === s.id || r.serviceId === s.id);
    for (const r of regs) lines.push(`DI: registered in ${r.file}:${r.line} as ${r.service} → ${r.implementation} (${r.container} ${r.method}${r.lifetime ? `, ${r.lifetime}` : ''})`);
    const inj = di.injections.filter((i) => i.consumer === s.id);
    for (const i of inj) lines.push(`DI: receives ${i.type} via ${i.via} injection${i.providers.length ? ` (provided by ${i.providers.map((p) => `${di.registrations[p].file}:${di.registrations[p].line}`).join(', ')})` : ''}`);
    const findings = g.model.findings.filter((f) => f.symbols.includes(s.id));
    for (const f of findings) lines.push(`FINDING: ${f.title} — ${f.detail}`);
    return lines.join('\n');
  }

  explainSymbolPrompt(s: SymbolInfo): ChatTurn[] {
    const owner = this.graph.ownerType(s);
    const content = `${this.projectSummary()}\n\n${this.symbolFacts(owner)}\n\nSOURCE:\n\`\`\`${s.language}\n${this.snippet(owner, 220)}\n\`\`\`
${owner !== s ? `\nThe user is asking specifically about member ${s.name} (line ${s.startLine}).\n` : ''}
Explain ${s.name} to a developer unfamiliar with this project. Use these sections:
## Purpose
## Responsibilities
## Dependencies (what it needs and why)
## How it interacts with other systems (callers, callees, DI, events)
## Why it exists (inference, with confidence)
## Potential concerns
## Where to look when debugging`;
    return [{ role: 'user', content }];
  }

  explainModulePrompt(mod: ModuleInfo): ChatTurn[] {
    const g = this.graph;
    const syms = mod.symbols.map((id) => g.get(id)).filter((s): s is SymbolInfo => !!s);
    const top = syms.map((s) => ({ s, n: g.dependents(s.id).length })).sort((a, b) => b.n - a.n).slice(0, 3);
    const snippets = top.map(({ s }) => `\`\`\`${s.language}\n${this.snippet(s, 80)}\n\`\`\``).join('\n');
    const content = `${this.projectSummary()}\n\n${this.moduleSummary(mod, true)}\n\nMOST-USED SOURCES:\n${snippets}\n
Explain the "${mod.name}" module: what it is responsible for, its key classes and how they collaborate, how it connects to other modules, and anything unusual. Use sections: ## Overview, ## Key classes, ## Collaboration, ## Connections to other modules, ## Concerns.`;
    return [{ role: 'user', content }];
  }

  explainProjectPrompt(): ChatTurn[] {
    const g = this.graph;
    const mods = [...g.model.modules].sort((a, b) => b.symbols.length - a.symbols.length).slice(0, 25);
    const hubs = this.hubs(15);
    const content = `${this.projectSummary()}\n\nMODULES:\n${mods.map((m) => this.moduleSummary(m, false)).join('\n')}
\nMOST DEPENDED-ON TYPES:\n${hubs.map(({ s, n }) => `- ${this.label(s)} · ${n} dependents`).join('\n')}
\nCOMPOSITION ROOTS:\n${this.compositionRoots().map((s) => `- ${this.label(s)}`).join('\n') || '- none detected'}
\nTOP FINDINGS:\n${g.model.findings.slice(0, 12).map((f) => `- [${f.severity}] ${f.title}`).join('\n') || '- none'}
\nExplain this project's architecture. Sections: ## Summary (3-5 sentences), ## Architecture style (with the evidence and confidence), ## Major systems, ## How a typical feature flows (UI → … → data), ## Dependency injection & composition, ## Conventions, ## Risks and smells. Link every system to real files.`;
    return [{ role: 'user', content }];
  }

  onboardingPrompt(): ChatTurn[] {
    const order = this.readingOrder();
    const content = `${this.projectSummary()}\n\nMODULES:\n${this.graph.model.modules.slice(0, 30).map((m) => this.moduleSummary(m, false)).join('\n')}
\nDETERMINISTIC READING ORDER (composition roots, then hubs, then per-module entry points):\n${order.map((s, i) => `${i + 1}. ${this.label(s)}`).join('\n')}
\nCreate an onboarding course for a developer who just joined. Start with "Welcome to ${this.graph.model.project.name}" and then 6 short lessons:
Lesson 1 Project structure, Lesson 2 Architecture, Lesson 3 Dependency injection & composition, Lesson 4 Core gameplay/business flow, Lesson 5 Data flow & persistence, Lesson 6 Conventions & where to start coding.
Each lesson: 3-6 bullets, the files to open (as links), and one small exercise ("find where X happens"). End with a recommended reading order (use the list above, explaining why each item is next).`;
    return [{ role: 'user', content }];
  }

  impactPrompt(report: ImpactReport): ChatTurn[] {
    const t = report.target.map((s) => this.label(s)).join(', ');
    const content = `${this.projectSummary()}\n\nCHANGE IMPACT for ${t}
Risk (heuristic): ${report.risk} (score ${report.score}) — ${report.reasons.join('; ')}
Direct dependents:\n${report.direct.map((d) => `- ${this.label(d.symbol)} via ${d.via.join('/')}`).join('\n') || '- none'}
Indirect dependents:\n${report.indirect.slice(0, 40).map((d) => `- ${this.label(d.symbol)} (distance ${d.distance})`).join('\n') || '- none'}
Modules affected: ${report.modulesAffected.map((m) => `${m.module.name} (${m.count})`).join(', ')}
\n${report.target.slice(0, 1).map((s) => this.symbolFacts(this.graph.ownerType(s))).join('\n')}
\nExplain in plain language what could break if this changes, which features/flows are most at risk, and what to test. Sections: ## Verdict, ## What could break, ## What to test, ## Safer ways to make the change.`;
    return [{ role: 'user', content }];
  }

  featurePrompt(flow: FeatureFlow): ChatTurn[] {
    const g = this.graph;
    const steps = flow.steps.map((st) => `${st.layer}: ${st.symbols.map((s) => this.label(s)).join(', ')}`).join('\n');
    const edges = flow.edges.slice(0, 60).map((e) => `${g.get(e.from)?.name} -${e.type}-> ${g.get(e.to)?.name} (${e.location?.file}:${e.location?.line})`).join('\n');
    const snippets = flow.seeds.slice(0, 4).map(({ symbol }) => `\`\`\`${symbol.language}\n${this.snippet(symbol, 90)}\n\`\`\``).join('\n');
    const content = `QUESTION: ${flow.query}\n\nRELEVANT SYMBOLS GROUPED BY LAYER (from static analysis):\n${steps}\n\nEDGES:\n${edges}\n\nSOURCE:\n${snippets}
\nDescribe the feature flow step by step (input → UI → … → data), as a numbered list where each step links to the file. Then list the files involved. Mention gaps if the static graph is incomplete.`;
    return [{ role: 'user', content }];
  }

  /** Retrieval for codebase chat: search relevant symbols → graph neighborhood → snippets → metadata. */
  chatContext(question: string, history: ChatTurn[]): string {
    const g = this.graph;
    const words = splitWords(question + ' ' + history.slice(-2).map((h) => h.content.slice(0, 300)).join(' '));
    const literal = new Set((question.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []));
    const scored = g.model.symbols
      .filter((s) => TYPE_KINDS.has(s.kind) || (!s.parent && s.kind === 'function'))
      .map((s) => ({ s, score: relevance(g, s, words) + (literal.has(s.name) ? 10 : 0) }))
      .filter((x) => x.score > 1.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    // methods named literally in the question
    const methodHits = g.model.symbols.filter((s) => (s.kind === 'method' || s.kind === 'function') && literal.has(s.name)).slice(0, 5);
    const parts: string[] = [this.projectSummary()];
    parts.push(`\nMODULES: ${g.model.modules.slice(0, 40).map((m) => `${m.name}${m.layer ? ` (${m.layer})` : ''}`).join(', ')}`);
    let budget = 60000;
    for (const [i, { s }] of scored.entries()) {
      const facts = this.symbolFacts(s);
      parts.push('\n' + facts);
      budget -= facts.length;
      if (i < 4 && budget > 8000) {
        const sn = this.snippet(s, i < 2 ? 160 : 80);
        parts.push(`SOURCE:\n\`\`\`${s.language}\n${sn}\n\`\`\``);
        budget -= sn.length;
      }
      if (budget < 4000) break;
    }
    for (const m of methodHits) {
      const callers = g.callers(m.id).map((r) => g.get(r.source)?.qualifiedName).filter(Boolean);
      const callees = g.callees(m.id).map((r) => g.get(r.target)?.qualifiedName).filter(Boolean);
      parts.push(`\nMETHOD ${m.qualifiedName} (${m.file}:${m.startLine}) callers: ${callers.join(', ') || 'none'}; callees: ${callees.join(', ') || 'none'}`);
      if (budget > 4000) parts.push(`\`\`\`${m.language}\n${this.snippet(m, 60)}\n\`\`\``);
    }
    if (!scored.length && !methodHits.length) parts.push('\n(No symbols matched the question directly; answer from the architecture summary and say what you could not find.)');
    return parts.join('\n');
  }

  hubs(n: number): { s: SymbolInfo; n: number }[] {
    const g = this.graph;
    return g.model.symbols
      .filter((s) => TYPE_KINDS.has(s.kind) && s.kind !== 'enum')
      .map((s) => ({ s, n: g.dependents(s.id).length }))
      .sort((a, b) => b.n - a.n)
      .slice(0, n);
  }

  compositionRoots(): SymbolInfo[] {
    const g = this.graph;
    const roots = new Set<string>();
    for (const r of g.model.di.registrations) if (r.scopeSymbol) roots.add(g.ownerType(g.get(r.scopeSymbol) ?? ({ id: r.scopeSymbol } as SymbolInfo)).id);
    for (const s of g.model.symbols) if (s.layer === 'Composition' && TYPE_KINDS.has(s.kind)) roots.add(s.id);
    return [...roots].map((id) => g.get(id)).filter((s): s is SymbolInfo => !!s).slice(0, 10);
  }

  /** Composition roots → most depended-on hubs → each module's main entry point. */
  readingOrder(): SymbolInfo[] {
    const g = this.graph;
    const order: SymbolInfo[] = [];
    const add = (s?: SymbolInfo): void => {
      if (s && !order.includes(s)) order.push(s);
    };
    this.compositionRoots().slice(0, 3).forEach(add);
    this.hubs(5).forEach(({ s }) => add(s));
    const mods = [...g.model.modules].filter((m) => m.layer !== 'Third-party').sort((a, b) => b.symbols.length - a.symbols.length).slice(0, 8);
    for (const m of mods) {
      const best = m.symbols.map((id) => g.get(id)).filter((s): s is SymbolInfo => !!s && TYPE_KINDS.has(s.kind))
        .sort((a, b) => g.dependents(b.id).length + g.dependencies(b.id).length - (g.dependents(a.id).length + g.dependencies(a.id).length))[0];
      add(best);
    }
    return order.slice(0, 15);
  }
}
