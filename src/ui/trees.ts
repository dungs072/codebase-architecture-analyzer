import * as vscode from 'vscode';
import { CALLABLE_KINDS, Finding, ModuleInfo, SymbolInfo, TYPE_KINDS } from '../model/types';
import { AnalysisState } from '../state';
import { HistoryEntry } from '../storage/store';

type Node =
  | { t: 'info'; label: string; description?: string; icon?: string; tooltip?: string; children?: Node[]; command?: vscode.Command }
  | { t: 'module'; module: ModuleInfo }
  | { t: 'layer'; name: string; modules: ModuleInfo[] }
  | { t: 'symbol'; symbol: SymbolInfo; description?: string }
  | { t: 'findingGroup'; kind: string; findings: Finding[] }
  | { t: 'finding'; finding: Finding };

const KIND_ICON: Record<string, string> = {
  class: 'symbol-class', interface: 'symbol-interface', struct: 'symbol-structure', enum: 'symbol-enum', record: 'symbol-class',
  type: 'symbol-type-parameter', function: 'symbol-function', variable: 'symbol-variable', method: 'symbol-method',
  constructor: 'symbol-constructor', property: 'symbol-property', field: 'symbol-field', namespace: 'symbol-namespace',
};

abstract class BaseTree implements vscode.TreeDataProvider<Node> {
  protected readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(protected readonly state: AnalysisState) {
    state.onDidChange(() => this.emitter.fire(undefined));
  }
  abstract getChildren(n?: Node): Node[];

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.t) {
      case 'info': {
        const it = new vscode.TreeItem(n.label, n.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        it.description = n.description;
        it.tooltip = n.tooltip ?? (n.description ? `${n.label} — ${n.description}` : n.label);
        if (n.icon) it.iconPath = new vscode.ThemeIcon(n.icon);
        it.command = n.command;
        return it;
      }
      case 'layer': {
        const it = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Expanded);
        it.iconPath = new vscode.ThemeIcon('layers');
        it.description = `${n.modules.length} module${n.modules.length === 1 ? '' : 's'}`;
        return it;
      }
      case 'module': {
        const it = new vscode.TreeItem(n.module.name, vscode.TreeItemCollapsibleState.Collapsed);
        it.iconPath = new vscode.ThemeIcon('package');
        it.description = `${n.module.symbols.length} symbols · ${n.module.files.length} files`;
        it.tooltip = `${n.module.path}\nLayer: ${n.module.layer ?? 'unknown'}\nDepends on: ${Object.keys(n.module.dependsOn).map((d) => this.state.graph?.moduleById.get(d)?.name ?? d).join(', ') || '—'}`;
        it.contextValue = 'module';
        it.id = 'module:' + n.module.id;
        it.command = { command: 'archAnalyzer.inspectSymbol', title: 'Inspect', arguments: [{ moduleId: n.module.id }] };
        return it;
      }
      case 'symbol': {
        const s = n.symbol;
        const hasChildren = TYPE_KINDS.has(s.kind) && (this.state.graph?.children.get(s.id)?.length ?? 0) > 0;
        const it = new vscode.TreeItem(s.name, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon(KIND_ICON[s.kind] ?? 'symbol-misc');
        it.description = n.description ?? (s.layer && TYPE_KINDS.has(s.kind) ? s.layer : CALLABLE_KINDS.has(s.kind) ? `(${(s.parameters ?? []).join(', ')})` : s.returnType);
        it.tooltip = `${s.qualifiedName}\n${s.file}:${s.startLine}`;
        it.contextValue = 'symbol';
        it.command = TYPE_KINDS.has(s.kind)
          ? { command: 'archAnalyzer.inspectSymbol', title: 'Inspect', arguments: [{ symbolId: s.id }] }
          : { command: 'archAnalyzer.openLocation', title: 'Open', arguments: [s.file, s.startLine] };
        return it;
      }
      case 'findingGroup': {
        const it = new vscode.TreeItem(labelForKind(n.kind), vscode.TreeItemCollapsibleState.Collapsed);
        it.description = String(n.findings.length);
        it.iconPath = new vscode.ThemeIcon(iconForKind(n.kind));
        return it;
      }
      case 'finding': {
        const f = n.finding;
        const it = new vscode.TreeItem(f.title, vscode.TreeItemCollapsibleState.None);
        it.description = f.location ? `${f.location.file.split('/').pop()}:${f.location.line}` : undefined;
        it.tooltip = new vscode.MarkdownString(`**${f.title}**\n\n${f.detail}`);
        it.iconPath = new vscode.ThemeIcon(f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'info',
          new vscode.ThemeColor(f.severity === 'error' ? 'errorForeground' : f.severity === 'warning' ? 'editorWarning.foreground' : 'editorInfo.foreground'));
        if (f.location) it.command = { command: 'archAnalyzer.openLocation', title: 'Open', arguments: [f.location.file, f.location.line] };
        if (f.symbols[0]) it.contextValue = 'finding';
        return it;
      }
    }
  }

  protected symbolChildren(s: SymbolInfo): Node[] {
    const members = this.state.graph?.children.get(s.id) ?? [];
    const order = ['constructor', 'method', 'function', 'property', 'field', 'class', 'interface', 'struct', 'enum', 'record', 'type'];
    return [...members].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.startLine - b.startLine).map((m) => ({ t: 'symbol', symbol: m }));
  }
}

export class OverviewTree extends BaseTree {
  constructor(state: AnalysisState, private readonly history: () => HistoryEntry[]) {
    super(state);
  }

  getChildren(n?: Node): Node[] {
    const m = this.state.model;
    if (!m) return [];
    if (n) return n.t === 'info' ? n.children ?? [] : [];
    const nodes: Node[] = [];
    nodes.push({
      t: 'info', label: m.project.name, icon: 'project',
      description: `${m.stats.types} types · ${m.stats.sourceFiles} files`,
      children: [
        { t: 'info', label: 'Languages', description: Object.entries(m.project.languages).map(([k, v]) => `${k} ${v}`).join(', '), icon: 'code' },
        { t: 'info', label: 'Frameworks', description: m.project.frameworks.join(', ') || '—', icon: 'extensions' },
        { t: 'info', label: 'Package managers', description: m.project.packageManagers.join(', ') || '—', icon: 'package' },
        { t: 'info', label: 'Source folders', description: m.project.sourceFolders.join(', '), icon: 'folder' },
        ...(m.project.testFolders.length ? [{ t: 'info' as const, label: 'Test folders', description: m.project.testFolders.join(', '), icon: 'beaker' }] : []),
        { t: 'info', label: 'Analysis', description: `${m.durationMs} ms · ${m.stats.parsedFiles} parsed, ${m.stats.cachedFiles} cached`, icon: 'clock' },
      ],
    });
    nodes.push({
      t: 'info', label: 'Detected Architecture', icon: 'type-hierarchy', description: m.patterns[0] ? `${m.patterns[0].name} (${pct(m.patterns[0].confidence)})` : 'no strong pattern',
      children: m.patterns.map((p) => ({
        t: 'info', label: p.name, description: `${p.category} · ${pct(p.confidence)}`, icon: confidenceIcon(p.confidence),
        tooltip: `${p.name} — confidence ${pct(p.confidence)}\n\nEvidence:\n${p.evidence.map((e) => '• ' + e).join('\n')}`,
        children: p.evidence.map((e) => ({ t: 'info', label: e, icon: 'debug-stackframe-dot' })),
      })),
    });
    nodes.push({
      t: 'info', label: 'Layers', icon: 'layers', description: m.layers.map((l) => l.name).join(' → '),
      children: m.layers.map((l) => ({ t: 'info', label: l.name, description: `${l.symbols} types`, icon: 'symbol-namespace', tooltip: l.evidence.join('\n') })),
    });
    nodes.push({ t: 'info', label: 'Open Architecture Map', icon: 'type-hierarchy-sub', command: { command: 'archAnalyzer.openGraph', title: 'Open' } });
    nodes.push({ t: 'info', label: 'Explain This Project', icon: 'sparkle', command: { command: 'archAnalyzer.explainProject', title: 'Explain' } });
    nodes.push({ t: 'info', label: 'Teach Me This Project', icon: 'mortar-board', command: { command: 'archAnalyzer.onboarding', title: 'Teach' } });
    nodes.push({ t: 'info', label: 'Trace a Feature…', icon: 'debug-alt', command: { command: 'archAnalyzer.traceFeature', title: 'Trace' } });
    nodes.push({ t: 'info', label: 'Generate ARCHITECTURE.md', icon: 'book', command: { command: 'archAnalyzer.generateDocs', title: 'Docs' } });
    const h = this.history();
    if (h.length > 1) {
      nodes.push({
        t: 'info', label: 'Analysis History', icon: 'history', description: `${h.length} snapshots`,
        children: h.map((e, i) => {
          const prev = h[i + 1];
          const added = prev ? e.modules.filter((x) => !prev.modules.some((p) => p.id === x.id)).map((x) => x.name) : [];
          const removed = prev ? prev.modules.filter((x) => !e.modules.some((p) => p.id === x.id)).map((x) => x.name) : [];
          const delta = prev ? e.stats.types - prev.stats.types : 0;
          return {
            t: 'info', label: new Date(e.analyzedAt).toLocaleString(), icon: 'git-commit',
            description: `${e.stats.types} types${prev ? ` (${delta >= 0 ? '+' : ''}${delta})` : ''} · ${e.modules.length} modules`,
            tooltip: [`Modules: ${e.modules.map((x) => x.name).join(', ')}`, added.length ? `Added: ${added.join(', ')}` : '', removed.length ? `Removed: ${removed.join(', ')}` : '', `Patterns: ${e.patterns.map((p) => p.name).join(', ')}`].filter(Boolean).join('\n'),
            children: [
              ...added.map((a) => ({ t: 'info' as const, label: `+ ${a}`, icon: 'diff-added' })),
              ...removed.map((a) => ({ t: 'info' as const, label: `− ${a}`, icon: 'diff-removed' })),
            ],
          };
        }),
      });
    }
    return nodes;
  }
}

export class ModulesTree extends BaseTree {
  getChildren(n?: Node): Node[] {
    const m = this.state.model;
    const g = this.state.graph;
    if (!m || !g) return [];
    if (!n) {
      const byLayer = new Map<string, ModuleInfo[]>();
      for (const mod of m.modules) {
        const l = mod.layer ?? 'Unclassified';
        byLayer.set(l, [...(byLayer.get(l) ?? []), mod]);
      }
      const order = [...m.layers.map((l) => l.name), 'Mixed', 'Unclassified', 'Third-party'];
      return [...byLayer].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([name, modules]) => ({ t: 'layer', name, modules }));
    }
    if (n.t === 'layer') return n.modules.map((module) => ({ t: 'module', module }));
    if (n.t === 'module') {
      return n.module.symbols.map((id) => g.get(id)).filter((s): s is SymbolInfo => !!s && !s.parent)
        .sort((a, b) => a.name.localeCompare(b.name)).map((symbol) => ({ t: 'symbol', symbol }));
    }
    if (n.t === 'symbol') return this.symbolChildren(n.symbol);
    return [];
  }
}

export class DITree extends BaseTree {
  getChildren(n?: Node): Node[] {
    const m = this.state.model;
    const g = this.state.graph;
    if (!m || !g) return [];
    const di = m.di;
    if (!n) {
      if (!di.registrations.length && !di.injections.length) return [{ t: 'info', label: 'No DI container usage detected', icon: 'info' }];
      const scopes = new Map<string, typeof di.registrations>();
      for (const r of di.registrations) scopes.set(r.scopeSymbol ?? r.file, [...(scopes.get(r.scopeSymbol ?? r.file) ?? []), r]);
      const scopeNodes: Node[] = [...scopes].map(([scopeId, regs]) => {
        const scope = g.get(scopeId);
        const owner = scope ? g.ownerType(scope) : undefined;
        return {
          t: 'info', label: owner?.name ?? scopeId, description: `${regs[0].container} · ${regs.length} registrations`, icon: 'server-environment',
          command: { command: 'archAnalyzer.openLocation', title: 'Open', arguments: [regs[0].file, regs[0].line] },
          children: regs.map((r) => ({
            t: 'info', label: r.service === r.implementation ? r.implementation : `${r.service} → ${r.implementation}`,
            description: [r.lifetime, r.method].filter(Boolean).join(' · '), icon: r.implementationId ? 'symbol-class' : 'question',
            tooltip: `${r.method}<${r.implementation}> at ${r.file}:${r.line}${r.implementationId ? '' : '\n(implementation type not found in analyzed code)'}`,
            command: { command: 'archAnalyzer.openLocation', title: 'Open', arguments: [r.file, r.line] },
          })),
        };
      });
      const consumers = new Map<string, typeof di.injections>();
      for (const i of di.injections) consumers.set(i.consumer, [...(consumers.get(i.consumer) ?? []), i]);
      const consumerNode: Node = {
        t: 'info', label: 'Consumers (Registration → Injection → Consumer)', icon: 'references', description: `${consumers.size}`,
        children: [...consumers].map(([cid, injs]) => {
          const c = g.get(cid);
          return {
            t: 'info', label: c?.name ?? cid, description: `${injs.length} injected`, icon: 'symbol-class',
            command: c ? { command: 'archAnalyzer.inspectSymbol', title: 'Inspect', arguments: [{ symbolId: c.id }] } : undefined,
            children: injs.map((i) => {
              const prov = i.providers.map((p) => di.registrations[p]);
              return {
                t: 'info', label: i.type, description: prov.length ? `← ${prov.map((p) => `${p.implementation} (${g.get(p.scopeSymbol ?? '')?.name ?? p.file})`).join(', ')}` : `${i.via} · no registration found`,
                icon: prov.length ? 'arrow-left' : 'warning',
                command: prov[0] ? { command: 'archAnalyzer.openLocation', title: 'Open registration', arguments: [prov[0].file, prov[0].line] } : c ? { command: 'archAnalyzer.openLocation', title: 'Open', arguments: [c.file, i.line] } : undefined,
              };
            }),
          };
        }),
      };
      return [...scopeNodes, consumerNode];
    }
    return n.t === 'info' ? n.children ?? [] : [];
  }
}

export class FindingsTree extends BaseTree {
  getChildren(n?: Node): Node[] {
    const m = this.state.model;
    if (!m) return [];
    if (!n) {
      if (!m.findings.length) return [{ t: 'info', label: 'No architecture smells found', icon: 'pass' }];
      const groups = new Map<string, Finding[]>();
      for (const f of m.findings) groups.set(f.kind, [...(groups.get(f.kind) ?? []), f]);
      return [...groups].map(([kind, findings]) => ({ t: 'findingGroup', kind, findings }));
    }
    if (n.t === 'findingGroup') return n.findings.map((finding) => ({ t: 'finding', finding }));
    return [];
  }
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
function confidenceIcon(c: number): string {
  return c >= 0.75 ? 'pass-filled' : c >= 0.5 ? 'circle-large-filled' : 'circle-large-outline';
}
function labelForKind(k: string): string {
  return ({
    'god-object': 'God Objects', 'circular-dependency': 'Circular Dependencies', 'layer-violation': 'Layer Violations',
    'excessive-coupling': 'Excessive Coupling', 'dead-code': 'Potentially Unused Code', 'duplicate-logic': 'Duplicate Logic', 'rule-violation': 'Rule Violations',
  } as Record<string, string>)[k] ?? k;
}
function iconForKind(k: string): string {
  return ({
    'god-object': 'flame', 'circular-dependency': 'sync', 'layer-violation': 'arrow-up', 'excessive-coupling': 'link',
    'dead-code': 'trash', 'duplicate-logic': 'copy', 'rule-violation': 'law',
  } as Record<string, string>)[k] ?? 'warning';
}
