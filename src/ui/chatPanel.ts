import * as vscode from 'vscode';
import { AnalysisState, openLocation } from '../state';
import { AIService, ChatTurn } from '../ai/provider';
import { SYSTEM_PROMPT } from '../ai/context';
import { webviewHtml } from './webviewHtml';

export class ChatPanel {
  static current: ChatPanel | undefined;
  private readonly history: ChatTurn[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private cts?: vscode.CancellationTokenSource;
  private ready = false;
  private queue: unknown[] = [];

  static show(ext: vscode.ExtensionContext, state: AnalysisState, ai: AIService): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(undefined, false);
      return ChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('archAnalyzer.chat', 'Codebase Chat', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ext.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(ext.extensionUri, 'media', 'icon.svg');
    ChatPanel.current = new ChatPanel(panel, ext, state, ai);
    return ChatPanel.current;
  }

  private constructor(readonly panel: vscode.WebviewPanel, ext: vscode.ExtensionContext, private readonly state: AnalysisState, private readonly ai: AIService) {
    panel.webview.html = webviewHtml(panel.webview, ext.extensionUri, 'Codebase Chat', ['md.js', 'chat.js'], ['map.css', 'chat.css']);
    panel.onDidDispose(() => {
      ChatPanel.current = undefined;
      this.cts?.cancel();
      this.disposables.forEach((d) => d.dispose());
    }, null, this.disposables);
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'ready') {
        this.ready = true;
        this.post({ type: 'init', project: state.model?.project.name ?? '', provider: ai.describe() });
        for (const q of this.queue.splice(0)) void panel.webview.postMessage(q);
      } else if (m.type === 'ask') await this.ask(m.text);
      else if (m.type === 'open') await openLocation(state, m.file, m.line);
      else if (m.type === 'stop') this.cts?.cancel();
      else if (m.type === 'clear') this.history.length = 0;
    }, null, this.disposables);
  }

  private post(msg: unknown): void {
    if (this.ready) void this.panel.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  async ask(question: string): Promise<void> {
    const ctx = this.state.ctx;
    if (!ctx) {
      this.post({ type: 'error', text: 'Analyze the project first (Architecture: Analyze Project).' });
      return;
    }
    this.post({ type: 'user', text: question });
    const context = ctx.chatContext(question, this.history);
    const messages: ChatTurn[] = [
      ...this.history.slice(-8),
      { role: 'user', content: `CONTEXT FROM STATIC ANALYSIS (retrieved for this question):\n${context}\n\nQUESTION: ${question}\n\nAnswer the question using the context. Cite files as [Name](path:line). If the context is insufficient, say what is missing and which files the user should open.` },
    ];
    const answer = await this.run(messages);
    if (answer !== undefined) {
      this.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    }
  }

  /** Runs a pre-built prompt (e.g. onboarding) and shows it as an assistant turn. */
  async runPrompt(title: string, messages: ChatTurn[]): Promise<void> {
    this.post({ type: 'user', text: title });
    const answer = await this.run(messages);
    if (answer !== undefined) this.history.push({ role: 'user', content: title }, { role: 'assistant', content: answer });
  }

  private async run(messages: ChatTurn[]): Promise<string | undefined> {
    this.cts?.cancel();
    const cts = (this.cts = new vscode.CancellationTokenSource());
    this.post({ type: 'start' });
    try {
      const text = await this.ai.complete({ system: SYSTEM_PROMPT, messages, token: cts.token, onText: (chunk) => this.post({ type: 'chunk', text: chunk }) });
      this.post({ type: 'done' });
      return text;
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }
}
