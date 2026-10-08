import * as vscode from 'vscode';
import { ArchitectureModel, SymbolInfo, TYPE_KINDS } from './model/types';
import { GraphIndex } from './analysis/graph';
import { ContextBuilder } from './ai/context';

/** Holds the current architecture model and notifies views when it changes. */
export class AnalysisState {
  private _model?: ArchitectureModel;
  private _graph?: GraphIndex;
  private _ctx?: ContextBuilder;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(readonly root: string) {}

  get model(): ArchitectureModel | undefined {
    return this._model;
  }
  get graph(): GraphIndex | undefined {
    return this._graph;
  }
  get ctx(): ContextBuilder | undefined {
    return this._ctx;
  }

  set(model: ArchitectureModel, graph?: GraphIndex): void {
    this._model = model;
    this._graph = graph ?? new GraphIndex(model);
    this._ctx = new ContextBuilder(this._graph, this.root);
    this.emitter.fire();
  }

  uri(file: string): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(this.root), ...file.split('/'));
  }

  /** Deepest symbol whose range contains the given position. */
  symbolAt(file: string, line: number): SymbolInfo | undefined {
    const syms = this._graph?.symbolsByFile.get(file) ?? [];
    let best: SymbolInfo | undefined;
    for (const s of syms) {
      if (line < s.startLine || line > s.endLine) continue;
      if (!best || s.endLine - s.startLine <= best.endLine - best.startLine) best = s;
    }
    return best;
  }

  typeAt(file: string, line: number): SymbolInfo | undefined {
    const s = this.symbolAt(file, line);
    return s && this._graph ? this._graph.ownerType(s) : s;
  }

  relPath(uri: vscode.Uri): string | undefined {
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    return rel === uri.fsPath ? undefined : rel;
  }

  isType(s: SymbolInfo): boolean {
    return TYPE_KINDS.has(s.kind);
  }
}

export async function openLocation(state: AnalysisState, file: string, line = 1): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(state.uri(file));
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true, viewColumn: vscode.ViewColumn.One });
}
