import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { analyzeProject } from './analysis/analyzer';
import { AnalysisStore } from './storage/store';
import { AnalysisState, openLocation } from './state';
import { AIService, SECRET_KEY } from './ai/provider';
import { SYSTEM_PROMPT } from './ai/context';
import { MapPanel } from './ui/mapPanel';
import { ChatPanel } from './ui/chatPanel';
import { DITree, FindingsTree, ModulesTree, OverviewTree } from './ui/trees';
import { generateArchitectureDoc } from './docs/docGenerator';
import { RULES_FILE_NAMES, RULES_TEMPLATE } from './analysis/rules';
import { ModuleInfo, SymbolInfo, TYPE_KINDS } from './model/types';

let running: Promise<void> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const ai = new AIService(context.secrets);
  const cmd = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  if (!folder) {
    const noWs = () => vscode.window.showInformationMessage('Open a folder to analyze its architecture.');
    for (const c of ['analyze', 'reanalyzeFull', 'openGraph', 'search', 'chat', 'explainProject', 'onboarding', 'traceFeature', 'generateDocs']) cmd(`archAnalyzer.${c}`, noWs);
    cmd('archAnalyzer.setAnthropicKey', () => setKey(context));
    return;
  }

  const root = folder.uri.fsPath;
  const storageDir = context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, crypto.createHash('sha1').update(root).digest('hex').slice(0, 12));
  const store = new AnalysisStore(storageDir);
  const state = new AnalysisState(root);
  const output = vscode.window.createOutputChannel('Architecture Analyzer');

  // ---------------------------------------------------------------- views
  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider('archAnalyzer.overview', new OverviewTree(state, () => store.loadHistory())),
    vscode.window.registerTreeDataProvider('archAnalyzer.modules', new ModulesTree(state)),
    vscode.window.registerTreeDataProvider('archAnalyzer.di', new DITree(state)),
    vscode.window.registerTreeDataProvider('archAnalyzer.findings', new FindingsTree(state)),
  );
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'archAnalyzer.openGraph';
  context.subscriptions.push(status);
  const updateStatus = () => {
    const m = state.model;
    status.text = m ? `$(type-hierarchy) ${m.stats.types} types · ${m.modules.length} modules` : '$(type-hierarchy) Analyze architecture';
    status.tooltip = m ? `Architecture model from ${new Date(m.analyzedAt).toLocaleString()}\n${m.patterns.slice(0, 3).map((p) => `${p.name} (${Math.round(p.confidence * 100)}%)`).join('\n')}\nClick to open the Architecture Map` : 'Click to analyze';
    status.command = m ? 'archAnalyzer.openGraph' : 'archAnalyzer.analyze';
    status.show();
  };
  state.onDidChange(updateStatus);

  const cached = store.loadModel();
  if (cached) state.set(cached);
  updateStatus();

  // ---------------------------------------------------------------- analysis
  const analyze = async (opts: { silent?: boolean; full?: boolean } = {}): Promise<void> => {
    if (running) return running;
    const cfg = vscode.workspace.getConfiguration('archAnalyzer');
    const work = async (progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken) => {
      if (opts.full) store.clearCache();
      let last = 0;
      const result = await analyzeProject(root, {
        exclude: cfg.get<string[]>('exclude', []),
        maxFiles: cfg.get<number>('maxFiles', 20000),
        smells: {
          godObjectDependencies: cfg.get<number>('smells.godObjectDependencies', 12),
          godObjectMethods: cfg.get<number>('smells.godObjectMethods', 30),
          couplingThreshold: cfg.get<number>('smells.couplingThreshold', 8),
        },
        cache: store.loadCache(),
        isCancelled: () => !!token?.isCancellationRequested,
        onProgress: (message, fraction) => {
          const inc = Math.max(0, fraction * 100 - last);
          last = fraction * 100;
          progress?.report({ message, increment: inc });
          if (opts.silent) status.text = `$(sync~spin) ${message}`;
        },
      });
      store.saveCache(result.parsed);
      store.saveModel(result.model);
      state.set(result.model, result.graph);
      const m = result.model;
      output.appendLine(`[${new Date().toLocaleTimeString()}] Analyzed ${m.stats.sourceFiles} files (${m.stats.parsedFiles} parsed, ${m.stats.cachedFiles} cached) in ${m.durationMs} ms: ${m.stats.types} types, ${m.stats.relationships} relationships, ${m.findings.length} findings.`);
      const errs = result.parsed.filter((p) => p.errors?.length);
      for (const e of errs.slice(0, 20)) output.appendLine(`  parse issue in ${e.file}: ${e.errors!.join('; ')}`);
      if (result.rulesError) {
        output.appendLine(`  rules file error: ${result.rulesError}`);
        vscode.window.showWarningMessage(`Architecture rules file could not be parsed: ${result.rulesError}`);
      }
      if (!opts.silent) {
        // Not awaited: the progress notification must close now, the follow-up is optional.
        const top = m.patterns[0];
        void vscode.window.showInformationMessage(
          `Analyzed ${m.stats.types} types in ${m.modules.length} modules${top ? ` — ${top.name} (${Math.round(top.confidence * 100)}%)` : ''}. ${m.findings.length} findings.`,
          'Open Architecture Map', 'Explain Project',
        ).then((pick) => {
          if (pick === 'Open Architecture Map') MapPanel.show(context, state, ai);
          else if (pick === 'Explain Project') void vscode.commands.executeCommand('archAnalyzer.explainProject');
        });
      }
    };
    running = (async () => {
      try {
        if (opts.silent) await work();
        else await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Analyzing architecture', cancellable: true }, work);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        output.appendLine(`Analysis failed: ${msg}\n${e instanceof Error ? e.stack : ''}`);
        if (!/cancelled/.test(msg)) vscode.window.showErrorMessage(`Architecture analysis failed: ${msg}`);
      } finally {
        running = undefined;
        updateStatus();
      }
    })();
    return running;
  };

  const ensureModel = async (): Promise<boolean> => {
    if (state.model) return true;
    await analyze();
    return !!state.model;
  };

  // ---------------------------------------------------------------- target resolution
  /** Accepts tree nodes, {symbolId}/{moduleId} args, or falls back to the cursor / a search picker. */
  const resolveTarget = async (arg: any, opts: { allowModule?: boolean; preferType?: boolean } = {}): Promise<{ symbol?: SymbolInfo; module?: ModuleInfo } | undefined> => {
    if (!(await ensureModel())) return undefined;
    const g = state.graph!;
    if (arg?.t === 'symbol' && arg.symbol) return { symbol: g.get(arg.symbol.id) };
    if (arg?.t === 'module' && arg.module) return { module: g.moduleById.get(arg.module.id) };
    if (arg?.symbolId) return { symbol: g.get(arg.symbolId) };
    if (arg?.moduleId) return { module: g.moduleById.get(arg.moduleId) };
    if (arg instanceof vscode.Uri) {
      const rel = state.relPath(arg);
      const types = rel ? (g.symbolsByFile.get(rel) ?? []).filter((s) => TYPE_KINDS.has(s.kind)) : [];
      if (types[0]) return { symbol: types[0] };
    }
    const ed = vscode.window.activeTextEditor;
    if (ed && !arg) {
      const rel = state.relPath(ed.document.uri);
      if (rel) {
        const s = opts.preferType ? state.typeAt(rel, ed.selection.active.line + 1) : state.symbolAt(rel, ed.selection.active.line + 1);
        if (s) return { symbol: s };
      }
    }
    return pickSymbol(opts.allowModule);
  };

  const pickSymbol = async (allowModule?: boolean): Promise<{ symbol?: SymbolInfo; module?: ModuleInfo } | undefined> => {
    const g = state.graph!;
    type Item = vscode.QuickPickItem & { symbol?: SymbolInfo; module?: ModuleInfo; file?: string };
    const qp = vscode.window.createQuickPick<Item>();
    qp.placeholder = 'Search classes, methods, interfaces, modules, files…';
    qp.matchOnDescription = true;
    const toItems = (q: string): Item[] =>
      g.search(q || 'a', 80)
        .filter((h) => allowModule !== false || h.kind !== 'module')
        .map((h) => ({
          label: `${h.kind === 'module' ? '$(package)' : h.kind === 'file' ? '$(file-code)' : iconFor(h.symbol!)} ${h.label}`,
          description: h.symbol ? h.symbol.qualifiedName : h.detail,
          detail: h.symbol ? `${h.symbol.kind} · ${h.symbol.file}:${h.symbol.startLine}${h.symbol.layer ? ' · ' + h.symbol.layer : ''}` : undefined,
          symbol: h.symbol, module: h.module, file: h.kind === 'file' ? h.id : undefined,
          alwaysShow: true,
        }));
    qp.items = toItems('');
    qp.onDidChangeValue((v) => (qp.items = toItems(v)));
    return new Promise((resolve) => {
      qp.onDidAccept(async () => {
        const it = qp.selectedItems[0];
        qp.hide();
        if (it?.file) {
          await openLocation(state, it.file, 1);
          resolve(undefined);
        } else resolve(it ? { symbol: it.symbol, module: it.module } : undefined);
      });
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
  };

  const map = () => MapPanel.show(context, state, ai);

  // ---------------------------------------------------------------- commands
  cmd('archAnalyzer.analyze', () => analyze());
  cmd('archAnalyzer.reanalyzeFull', () => analyze({ full: true }));
  cmd('archAnalyzer.openGraph', async () => {
    if (await ensureModel()) map();
  });
  cmd('archAnalyzer.openLocation', (file: string, line: number) => openLocation(state, file, line));

  cmd('archAnalyzer.search', async () => {
    if (!(await ensureModel())) return;
    const t = await pickSymbol(true);
    if (t?.module) map().inspectModule(t.module.id);
    else if (t?.symbol) {
      await openLocation(state, t.symbol.file, t.symbol.startLine);
      map().inspectSymbol(t.symbol.id);
    }
  });

  const inspect = async (arg?: any) => {
    const t = await resolveTarget(arg, { allowModule: true });
    if (t?.module) map().inspectModule(t.module.id);
    else if (t?.symbol) {
      const p = map();
      p.post({ type: 'reveal', id: state.graph!.ownerType(t.symbol).id });
      p.inspectSymbol(t.symbol.id);
    }
  };
  cmd('archAnalyzer.inspectSymbol', inspect);
  cmd('archAnalyzer.inspectAtCursor', () => inspect());

  cmd('archAnalyzer.showCallers', async (arg?: any) => {
    const t = await resolveTarget(arg);
    if (t?.symbol) map().showCallTree(t.symbol.id, 'callers');
  });
  cmd('archAnalyzer.showCallees', async (arg?: any) => {
    const t = await resolveTarget(arg);
    if (t?.symbol) map().showCallTree(t.symbol.id, 'callees');
  });

  const depsPicker = async (arg: any, dir: 'dependencies' | 'dependents') => {
    const t = await resolveTarget(arg, { preferType: true });
    if (!t?.symbol) return;
    const g = state.graph!;
    const owner = g.ownerType(t.symbol);
    const list = dir === 'dependencies' ? g.dependencies(owner.id) : g.dependents(owner.id);
    if (!list.length) return vscode.window.showInformationMessage(`${owner.name} has no ${dir} in analyzed code.`);
    const pick = await vscode.window.showQuickPick(
      list.map((d) => ({ label: `${iconFor(d.symbol)} ${d.symbol.name}`, description: d.types.join(', '), detail: `${d.symbol.file}:${d.rels[0]?.location?.line ?? d.symbol.startLine}`, d })),
      { title: `${dir === 'dependencies' ? 'Dependencies of' : 'Dependents of'} ${owner.name}`, matchOnDescription: true },
    );
    if (pick) {
      const loc = dir === 'dependents' ? pick.d.rels[0]?.location : undefined;
      await openLocation(state, loc?.file ?? pick.d.symbol.file, loc?.line ?? pick.d.symbol.startLine);
    }
  };
  cmd('archAnalyzer.showDependencies', (arg?: any) => depsPicker(arg, 'dependencies'));
  cmd('archAnalyzer.showDependents', (arg?: any) => depsPicker(arg, 'dependents'));

  cmd('archAnalyzer.findReferences', async (arg?: any) => {
    const t = await resolveTarget(arg);
    const s = t?.symbol;
    if (!s) return;
    // Prefer the language server (exact), fall back to the analysis graph.
    try {
      const uri = state.uri(s.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const lineText = doc.lineAt(Math.max(0, s.startLine - 1)).text;
      const col = Math.max(0, lineText.search(new RegExp(`\\b${s.name.replace(/[^\w]/g, '')}\\b`)));
      const pos = new vscode.Position(s.startLine - 1, col);
      const locs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, pos);
      if (locs?.length) {
        await vscode.commands.executeCommand('editor.action.showReferences', uri, pos, locs);
        return;
      }
    } catch {
      /* no language server */
    }
    const g = state.graph!;
    const rels = [...g.selfAndMembers(s.id)].flatMap((m) => g.incoming(m.id).filter((r) => r.type !== 'contains'));
    if (!rels.length) return vscode.window.showInformationMessage(`No references to ${s.name} found.`);
    const pick = await vscode.window.showQuickPick(
      rels.map((r) => ({ label: `${g.get(r.source)?.qualifiedName ?? r.source}`, description: r.type, detail: `${r.location?.file}:${r.location?.line}`, r })),
      { title: `References to ${s.name} (from analysis graph)` },
    );
    if (pick?.r.location) await openLocation(state, pick.r.location.file, pick.r.location.line);
  });

  cmd('archAnalyzer.analyzeImpact', async (arg?: any) => {
    if (!(await ensureModel())) return;
    let ids: string[] = [];
    if (!arg && vscode.window.activeTextEditor) {
      const ed = vscode.window.activeTextEditor;
      const rel = state.relPath(ed.document.uri);
      if (rel) {
        const at = state.typeAt(rel, ed.selection.active.line + 1);
        ids = at ? [at.id] : (state.graph!.symbolsByFile.get(rel) ?? []).filter((x) => TYPE_KINDS.has(x.kind)).map((x) => x.id);
      }
    }
    if (!ids.length) {
      const t = await resolveTarget(arg, { preferType: true });
      if (t?.symbol) ids = [t.symbol.id];
    }
    if (ids.length) await map().showImpact(ids);
  });

  cmd('archAnalyzer.traceFeature', async (query?: string) => {
    if (!(await ensureModel())) return;
    const q = typeof query === 'string' ? query : await vscode.window.showInputBox({ prompt: 'Which feature do you want to trace?', placeHolder: 'e.g. How does hiring staff work? / Harvest crop / checkout payment' });
    if (q) await map().showFlow(q);
  });

  cmd('archAnalyzer.explainSymbol', async (arg?: any) => {
    const t = await resolveTarget(arg, { allowModule: true });
    if (t?.module) await map().explainModule(t.module.id);
    else if (t?.symbol) await map().explainSymbol(t.symbol.id);
  });
  cmd('archAnalyzer.explainModule', async (arg?: any) => {
    if (!(await ensureModel())) return;
    let mod = arg?.module as ModuleInfo | undefined;
    if (!mod) {
      const pick = await vscode.window.showQuickPick(state.model!.modules.map((m) => ({ label: m.name, description: `${m.layer ?? ''} · ${m.path}`, m })), { title: 'Explain which module?' });
      mod = pick?.m;
    }
    if (mod) await map().explainModule(mod.id);
  });
  cmd('archAnalyzer.explainProject', async () => {
    if (!(await ensureModel())) return;
    await map().explainProject();
  });
  cmd('archAnalyzer.onboarding', async () => {
    if (!(await ensureModel())) return;
    await ChatPanel.show(context, state, ai).runPrompt('Teach me this project', state.ctx!.onboardingPrompt());
  });
  cmd('archAnalyzer.chat', async (question?: string) => {
    if (!(await ensureModel())) return;
    const panel = ChatPanel.show(context, state, ai);
    if (typeof question === 'string' && question) await panel.ask(question);
  });

  cmd('archAnalyzer.generateDocs', async () => {
    if (!(await ensureModel())) return;
    const withAI = await vscode.window.showQuickPick(
      [{ label: 'Facts only', description: 'deterministic, no AI', ai: false }, { label: 'Facts + AI overview', description: ai.describe(), ai: true }],
      { title: 'Generate ARCHITECTURE.md' },
    );
    if (!withAI) return;
    const target = path.join(root, 'ARCHITECTURE.md');
    if (fs.existsSync(target)) {
      const ok = await vscode.window.showWarningMessage('ARCHITECTURE.md already exists. Overwrite it?', { modal: true }, 'Overwrite');
      if (ok !== 'Overwrite') return;
    }
    let overview: string | undefined;
    if (withAI.ai) {
      overview = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Writing AI overview…', cancellable: true }, async (_p, token) => {
        try {
          const turns = state.ctx!.explainProjectPrompt();
          turns[0].content += '\n\nFor this document, write only the "Summary" and "Architecture style" sections (max ~250 words), using markdown links to files.';
          return await ai.complete({ system: SYSTEM_PROMPT, messages: turns, token, onText: () => undefined });
        } catch (e) {
          vscode.window.showWarningMessage(`AI overview skipped: ${e instanceof Error ? e.message : e}`);
          return undefined;
        }
      });
    }
    fs.writeFileSync(target, generateArchitectureDoc(state.graph!, state.ctx!, overview));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('markdown.showPreviewToSide');
  });

  cmd('archAnalyzer.setAnthropicKey', () => setKey(context));

  // Internal (not contributed to the palette): webview health for integration tests and bug reports.
  MapPanel.diagnostics.log = (msg) => output.appendLine(msg);
  cmd('archAnalyzer._diagnostics', () => ({
    hasModel: !!state.model,
    types: state.model?.stats.types,
    mapOpen: !!MapPanel.current,
    chatOpen: !!ChatPanel.current,
    webviewErrors: [...MapPanel.diagnostics.errors],
    lastRender: MapPanel.diagnostics.lastRender,
  }));

  cmd('archAnalyzer.createRulesFile', async () => {
    const existing = RULES_FILE_NAMES.map((n) => path.join(root, n)).find((p) => fs.existsSync(p));
    const target = existing ?? path.join(root, RULES_FILE_NAMES[0]);
    if (!existing) fs.writeFileSync(target, RULES_TEMPLATE);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    if (!existing) vscode.window.showInformationMessage('Rules are checked on every analysis. Edit them, save, and re-run "Architecture: Analyze Project".');
  });

  // ---------------------------------------------------------------- incremental re-analysis
  let saveTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!state.model || !vscode.workspace.getConfiguration('archAnalyzer').get('reanalyzeOnSave', true)) return;
      const isSource = /\.(cs|tsx?|mts|cts|jsx?|mjs)$/.test(doc.fileName);
      const isRules = RULES_FILE_NAMES.some((n) => doc.fileName.endsWith(n));
      if (!isSource && !isRules) return;
      if (!doc.uri.fsPath.startsWith(root)) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void analyze({ silent: true }), 1500);
    }),
    { dispose: () => clearTimeout(saveTimer) },
  );

  if (!cached && vscode.workspace.getConfiguration('archAnalyzer').get('analyzeOnStartup', false)) void analyze({ silent: true });
}

async function setKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({ prompt: 'Anthropic API key (stored in VS Code secret storage)', password: true, ignoreFocusOut: true, placeHolder: 'sk-ant-…' });
  if (key === undefined) return;
  if (!key) {
    await context.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('Anthropic API key removed.');
    return;
  }
  await context.secrets.store(SECRET_KEY, key.trim());
  const cfg = vscode.workspace.getConfiguration('archAnalyzer.ai');
  if (cfg.get('provider') !== 'anthropic') {
    const sw = await vscode.window.showInformationMessage('API key saved. Use Anthropic as the AI provider?', 'Use Anthropic');
    if (sw) await cfg.update('provider', 'anthropic', vscode.ConfigurationTarget.Global);
  } else vscode.window.showInformationMessage('Anthropic API key saved.');
}

function iconFor(s: SymbolInfo): string {
  const m: Record<string, string> = {
    class: '$(symbol-class)', interface: '$(symbol-interface)', struct: '$(symbol-structure)', enum: '$(symbol-enum)', record: '$(symbol-class)',
    type: '$(symbol-type-parameter)', function: '$(symbol-function)', variable: '$(symbol-variable)', method: '$(symbol-method)',
    constructor: '$(symbol-constructor)', property: '$(symbol-property)', field: '$(symbol-field)',
  };
  return m[s.kind] ?? '$(symbol-misc)';
}

export function deactivate(): void {
  /* nothing */
}
