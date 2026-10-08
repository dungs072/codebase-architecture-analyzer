import * as vscode from 'vscode';
import { CALLABLE_KINDS, SymbolInfo, TYPE_KINDS } from '../model/types';
import { AnalysisState, openLocation } from '../state';
import { AIService, ChatTurn } from '../ai/provider';
import { SYSTEM_PROMPT } from '../ai/context';
import { CallTreeNode, DEPENDENCY_TYPES } from '../analysis/graph';
import { traceFeature } from '../analysis/features';
import { webviewHtml } from './webviewHtml';

/** Graph level 1-2 payload: modules, top-level symbols and aggregated type-level edges. */
function buildGraphPayload(state: AnalysisState) {
  const g = state.graph!;
  const m = state.model!;
  const isNode = (s: SymbolInfo) => TYPE_KINDS.has(s.kind) || (!s.parent && s.kind === 'function');
  const nodes = m.symbols.filter(isNode).map((s) => ({
    id: s.id, name: s.name, kind: s.kind, module: s.module, layer: s.layer, file: s.file, line: s.startLine,
    parent: s.parent && TYPE_KINDS.has(g.get(s.parent)?.kind ?? 'field') ? s.parent : undefined,
  }));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const lift = (id: string): string | undefined => {
    const s = g.get(id);
    if (!s) return undefined;
    if (nodeIds.has(id)) return id;
    const o = g.ownerType(s);
    return nodeIds.has(o.id) ? o.id : undefined;
  };
  const agg = new Map<string, { s: string; t: string; types: Set<string>; w: number }>();
  for (const r of m.relationships) {
    if (!DEPENDENCY_TYPES.has(r.type) && r.type !== 'calls' && r.type !== 'registers') continue;
    const s = lift(r.source);
    const t = lift(r.target);
    if (!s || !t || s === t) continue;
    const k = `${s}|${t}`;
    let e = agg.get(k);
    if (!e) agg.set(k, (e = { s, t, types: new Set(), w: 0 }));
    e.types.add(r.type);
    e.w++;
  }
  return {
    project: m.project.name,
    analyzedAt: m.analyzedAt,
    layers: m.layers.map((l) => ({ name: l.name, rank: l.rank })),
    modules: m.modules.map((x) => ({ id: x.id, name: x.name, layer: x.layer, files: x.files.length, symbols: x.symbols.length, dependsOn: x.dependsOn })),
    nodes,
    edges: [...agg.values()].map((e) => ({ s: e.s, t: e.t, types: [...e.types], w: e.w })),
    patterns: m.patterns.slice(0, 4).map((p) => ({ name: p.name, confidence: p.confidence })),
    findingsBySymbol: m.findings.reduce<Record<string, string>>((acc, f) => {
      for (const id of f.symbols) if (!acc[id] || f.severity === 'error') acc[id] = f.severity;
      return acc;
    }, {}),
  };
}

function typeLabel(s: SymbolInfo): string {
  const suffix = /(Service|Manager|Controller|Presenter|ViewModel|View|Screen|Panel|Repository|Store|Data|Model|Config|Factory|Action|Command|State|System|Handler|Provider|Installer|LifetimeScope|Helper|Util|Utils)$/.exec(s.name)?.[1];
  return [s.kind, suffix && suffix.toLowerCase() !== s.kind ? suffix : undefined, s.modifiers?.includes('abstract') ? 'abstract' : undefined, s.modifiers?.includes('static') ? 'static' : undefined].filter(Boolean).join(' · ');
}

export class MapPanel {
  static current: MapPanel | undefined;
  /** Webview health, surfaced in the output channel and via the internal diagnostics command. */
  static readonly diagnostics = { errors: [] as string[], lastRender: undefined as { nodes: number; edges: number } | undefined, log: (_: string) => {} };
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private queue: unknown[] = [];
  private aiCts?: vscode.CancellationTokenSource;

  static show(ext: vscode.ExtensionContext, state: AnalysisState, ai: AIService): MapPanel {
    if (MapPanel.current) {
      MapPanel.current.panel.reveal(MapPanel.current.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
      return MapPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('archAnalyzer.map', 'Architecture Map', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ext.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(ext.extensionUri, 'media', 'icon.svg');
    MapPanel.current = new MapPanel(ext, panel, state, ai);
    return MapPanel.current;
  }

  private constructor(private readonly ext: vscode.ExtensionContext, readonly panel: vscode.WebviewPanel, private readonly state: AnalysisState, private readonly ai: AIService) {
    panel.webview.html = webviewHtml(panel.webview, ext.extensionUri, 'Architecture Map', ['vendor/cytoscape.min.js', 'md.js', 'map.js'], ['map.css']);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    state.onDidChange(() => this.sendGraph(), null, this.disposables);
  }

  dispose(): void {
    MapPanel.current = undefined;
    this.aiCts?.cancel();
    this.disposables.forEach((d) => d.dispose());
  }

  post(msg: unknown): void {
    if (!this.ready) this.queue.push(msg);
    else void this.panel.webview.postMessage(msg);
  }

  private sendGraph(): void {
    if (!this.state.model) return;
    this.post({ type: 'graph', data: buildGraphPayload(this.state) });
  }

  private async onMessage(m: any): Promise<void> {
    const g = this.state.graph;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.sendGraph();
        for (const q of this.queue.splice(0)) void this.panel.webview.postMessage(q);
        return;
      case 'open':
        await openLocation(this.state, m.file, m.line);
        return;
      case 'inspect':
        if (m.moduleId) this.inspectModule(m.moduleId);
        else this.inspectSymbol(m.id);
        return;
      case 'members':
        this.sendMembers(m.id);
        return;
      case 'explain':
        if (m.moduleId) await this.explainModule(m.moduleId);
        else await this.explainSymbol(m.id);
        return;
      case 'explainProject':
        await vscode.commands.executeCommand('archAnalyzer.explainProject');
        return;
      case 'impact':
        await this.showImpact([m.id]);
        return;
      case 'callTree':
        this.showCallTree(m.id, m.direction);
        return;
      case 'trace':
        if (m.query) await this.showFlow(m.query);
        else await vscode.commands.executeCommand('archAnalyzer.traceFeature');
        return;
      case 'path': {
        if (!g) return;
        const p = g.findPath(m.from, m.to) ?? g.findPath(m.to, m.from);
        this.post({ type: 'highlightPath', ids: p ? p.map((s) => g.ownerType(s).id) : [], found: !!p });
        return;
      }
      case 'search': {
        if (!g) return;
        const hits = g.search(m.query, 25).map((h) => ({ kind: h.kind, id: h.id, label: h.label, detail: h.detail, moduleId: h.module?.id, file: h.kind === 'file' ? h.id : undefined }));
        this.post({ type: 'searchResults', hits });
        return;
      }
      case 'chat':
        await vscode.commands.executeCommand('archAnalyzer.chat', m.question);
        return;
      case 'findRefs':
        await vscode.commands.executeCommand('archAnalyzer.findReferences', { symbolId: m.id });
        return;
      case 'cancelAI':
        this.aiCts?.cancel();
        return;
      case 'webviewError':
        MapPanel.diagnostics.errors.push(m.message);
        MapPanel.diagnostics.log(`Architecture Map webview error: ${m.message}`);
        return;
      case 'rendered':
        MapPanel.diagnostics.lastRender = { nodes: m.nodes, edges: m.edges };
        return;
    }
  }

  // ------------------------------------------------------------------ inspector
  inspectSymbol(id: string): void {
    const g = this.state.graph;
    const s = g?.get(id);
    if (!g || !s) return;
    const owner = g.ownerType(s);
    const members = (g.children.get(owner.id) ?? []).map((c) => ({
      id: c.id, name: c.name, kind: c.kind, line: c.startLine, vis: c.visibility, params: c.parameters, ret: c.returnType,
      callers: g.callers(c.id).length, callees: g.callees(c.id).length,
    }));
    const pack = (x: { symbol: SymbolInfo; types: string[] }) => ({ id: x.symbol.id, name: x.symbol.name, kind: x.symbol.kind, layer: x.symbol.layer, types: x.types, file: x.symbol.file, line: x.symbol.startLine });
    const deps = g.dependencies(owner.id);
    const users = g.dependents(owner.id);
    const di = this.state.model!.di;
    const scopeName = (sid?: string) => (sid ? g.ownerType(g.get(sid) ?? owner).name : '');
    const regs = di.registrations.filter((r) => r.implementationId === owner.id || r.serviceId === owner.id)
      .map((r) => ({ service: r.service, impl: r.implementation, lifetime: r.lifetime, method: r.method, file: r.file, line: r.line, scope: scopeName(r.scopeSymbol), container: r.container }));
    const injections = di.injections.filter((i) => i.consumer === owner.id).map((i) => ({
      type: i.type, via: i.via, line: i.line,
      providers: i.providers.map((p) => ({ impl: di.registrations[p].implementation, file: di.registrations[p].file, line: di.registrations[p].line, scope: scopeName(di.registrations[p].scopeSymbol) })),
    }));
    const injectedInto = di.injections.filter((i) => i.typeId === owner.id).map((i) => ({ id: i.consumer, name: g.get(i.consumer)?.name ?? i.consumer, via: i.via }));
    const findings = this.state.model!.findings.filter((f) => f.symbols.includes(owner.id)).map((f) => ({ title: f.title, detail: f.detail, severity: f.severity, file: f.location?.file, line: f.location?.line }));
    let callsIn = 0;
    let callsOut = 0;
    for (const c of g.selfAndMembers(owner.id)) {
      callsIn += g.callers(c.id).filter((r) => g.ownerType(g.get(r.source) ?? c).id !== owner.id).length;
      callsOut += g.callees(c.id).filter((r) => g.ownerType(g.get(r.target) ?? c).id !== owner.id).length;
    }
    const quick = g.impact([owner.id], 3);
    this.post({
      type: 'inspector',
      data: {
        kind: 'symbol', id: owner.id, focusMember: s.id !== owner.id ? s.id : undefined, name: owner.name, qualifiedName: owner.qualifiedName,
        typeLabel: typeLabel(owner), language: owner.language, file: owner.file, line: owner.startLine, endLine: owner.endLine,
        layer: owner.layer, module: owner.module ? { id: owner.module, name: g.moduleById.get(owner.module)?.name } : undefined,
        baseTypes: owner.baseTypes, attributes: owner.attributes,
        metrics: { deps: deps.length, users: users.length, methods: members.filter((x) => x.kind === 'method').length, lines: owner.endLine - owner.startLine + 1, callsIn, callsOut },
        deps: deps.map(pack), users: users.map(pack), members, di: { registrations: regs, injections, injectedInto }, findings,
        risk: { level: quick.risk, reasons: quick.reasons },
        isCallable: CALLABLE_KINDS.has(s.kind),
      },
    });
    this.panel.reveal(undefined, true);
  }

  inspectModule(id: string): void {
    const g = this.state.graph;
    const mod = g?.moduleById.get(id);
    if (!g || !mod) return;
    const syms = mod.symbols.map((x) => g.get(x)).filter((s): s is SymbolInfo => !!s);
    this.post({
      type: 'inspector',
      data: {
        kind: 'module', id: mod.id, name: mod.name, path: mod.path, layer: mod.layer, files: mod.files,
        symbols: syms.map((s) => ({ id: s.id, name: s.name, kind: s.kind, layer: s.layer, users: g.dependents(s.id).length, file: s.file, line: s.startLine })).sort((a, b) => b.users - a.users),
        dependsOn: Object.entries(mod.dependsOn).map(([mid, w]) => ({ id: mid, name: g.moduleById.get(mid)?.name ?? mid, w })).sort((a, b) => b.w - a.w),
        usedBy: this.state.model!.modules.filter((x) => x.dependsOn[mod.id]).map((x) => ({ id: x.id, name: x.name, w: x.dependsOn[mod.id] })).sort((a, b) => b.w - a.w),
        findings: this.state.model!.findings.filter((f) => f.symbols.some((sid) => g.get(sid)?.module === mod.id)).slice(0, 30).map((f) => ({ title: f.title, detail: f.detail, severity: f.severity, file: f.location?.file, line: f.location?.line })),
      },
    });
    this.panel.reveal(undefined, true);
  }

  private sendMembers(typeId: string): void {
    const g = this.state.graph;
    if (!g) return;
    const members = (g.children.get(typeId) ?? []).filter((c) => CALLABLE_KINDS.has(c.kind) || c.kind === 'property');
    const ids = new Set(members.map((m) => m.id));
    const edges: { s: string; t: string; sOwner: string; tOwner: string }[] = [];
    for (const m of members) {
      for (const r of [...g.callees(m.id), ...g.callers(m.id)]) {
        const a = g.get(r.source);
        const b = g.get(r.target);
        if (!a || !b) continue;
        edges.push({ s: a.id, t: b.id, sOwner: g.ownerType(a).id, tOwner: g.ownerType(b).id });
      }
    }
    void ids;
    this.post({ type: 'members', typeId, members: members.map((m) => ({ id: m.id, name: m.name, kind: m.kind, line: m.startLine, file: m.file })), edges });
  }

  // ------------------------------------------------------------------ analyses
  async showImpact(ids: string[]): Promise<void> {
    const g = this.state.graph;
    const ctx = this.state.ctx;
    if (!g || !ctx) return;
    const r = g.impact(ids);
    const pk = (s: SymbolInfo) => ({ id: s.id, name: s.name, kind: s.kind, layer: s.layer, file: s.file, line: s.startLine });
    this.post({
      type: 'impact',
      data: {
        targets: r.target.map(pk), risk: r.risk, score: r.score, reasons: r.reasons,
        direct: r.direct.map((d) => ({ ...pk(d.symbol), via: d.via })),
        indirect: r.indirect.map((d) => ({ ...pk(d.symbol), distance: d.distance })),
        modules: r.modulesAffected.map((m) => ({ id: m.module.id, name: m.module.name, count: m.count })),
        highlight: [...r.target.map((s) => g.ownerType(s).id), ...r.direct.map((d) => d.symbol.id), ...r.indirect.map((d) => d.symbol.id)],
      },
    });
    this.panel.reveal(undefined, true);
    await this.streamAI('Impact explanation', ctx.impactPrompt(r));
  }

  showCallTree(id: string, direction: 'callers' | 'callees'): void {
    const g = this.state.graph;
    if (!g) return;
    const tree = g.callTree(id, direction, 5);
    const conv = (n: CallTreeNode): unknown => ({
      id: n.symbol.id, name: n.symbol.qualifiedName.split('.').slice(-2).join('.'), kind: n.symbol.kind, file: n.rel?.location?.file ?? n.symbol.file,
      line: n.rel?.location?.line ?? n.symbol.startLine, defFile: n.symbol.file, defLine: n.symbol.startLine, truncated: n.truncated, confidence: n.rel?.confidence,
      children: n.children.map(conv),
    });
    this.post({ type: 'callTree', direction, data: tree ? conv(tree) : undefined });
    this.panel.reveal(undefined, true);
  }

  async showFlow(query: string): Promise<void> {
    const g = this.state.graph;
    const ctx = this.state.ctx;
    if (!g || !ctx) return;
    const flow = traceFeature(g, query);
    const pk = (s: SymbolInfo) => ({ id: s.id, name: s.name, kind: s.kind, layer: s.layer, file: s.file, line: s.startLine, module: s.module });
    this.post({
      type: 'flow',
      data: {
        query, steps: flow.steps.map((st) => ({ layer: st.layer, symbols: st.symbols.map(pk) })),
        edges: flow.edges.map((e) => ({ s: e.from, t: e.to, type: e.type, file: e.location?.file, line: e.location?.line })),
        entryPoints: flow.entryPoints.map(pk), files: flow.files,
      },
    });
    this.panel.reveal(undefined, true);
    if (flow.seeds.length) await this.streamAI(`Feature: ${query}`, ctx.featurePrompt(flow));
  }

  async explainSymbol(id: string): Promise<void> {
    const s = this.state.graph?.get(id);
    if (!s || !this.state.ctx) return;
    this.inspectSymbol(id);
    await this.streamAI(`Explain ${s.name}`, this.state.ctx.explainSymbolPrompt(s));
  }

  async explainModule(id: string): Promise<void> {
    const mod = this.state.graph?.moduleById.get(id);
    if (!mod || !this.state.ctx) return;
    this.inspectModule(id);
    await this.streamAI(`Explain module ${mod.name}`, this.state.ctx.explainModulePrompt(mod));
  }

  async explainProject(): Promise<void> {
    if (!this.state.ctx) return;
    await this.streamAI(`Explain ${this.state.model!.project.name}`, this.state.ctx.explainProjectPrompt());
  }

  async streamAI(title: string, messages: ChatTurn[]): Promise<string | undefined> {
    this.aiCts?.cancel();
    const cts = (this.aiCts = new vscode.CancellationTokenSource());
    this.post({ type: 'ai', reset: true, title, provider: this.ai.describe() });
    try {
      const text = await this.ai.complete({ system: SYSTEM_PROMPT, messages, token: cts.token, onText: (chunk) => this.post({ type: 'ai', chunk }) });
      this.post({ type: 'ai', done: true });
      return text;
    } catch (e) {
      this.post({ type: 'ai', error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }
}
