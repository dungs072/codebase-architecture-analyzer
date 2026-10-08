import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIRequest {
  system: string;
  messages: ChatTurn[];
  onText: (chunk: string) => void;
  token?: vscode.CancellationToken;
}

export const SECRET_KEY = 'archAnalyzer.anthropicApiKey';

export class AIService {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private cfg() {
    return vscode.workspace.getConfiguration('archAnalyzer.ai');
  }

  describe(): string {
    const provider = this.cfg().get<string>('provider', 'vscode-lm');
    return provider === 'anthropic' ? `Anthropic (${this.cfg().get('anthropicModel')})` : 'VS Code language model';
  }

  /** Streams a completion; returns the full text. */
  async complete(req: AIRequest): Promise<string> {
    const provider = this.cfg().get<string>('provider', 'vscode-lm');
    if (provider === 'anthropic') return this.anthropic(req);
    try {
      return await this.vscodeLm(req);
    } catch (e) {
      if (e instanceof NoModelError) {
        const key = await this.secrets.get(SECRET_KEY);
        if (key || process.env.ANTHROPIC_API_KEY) return this.anthropic(req);
        void vscode.window
          .showWarningMessage('No VS Code language model is available (e.g. GitHub Copilot). Configure an Anthropic API key instead?', 'Set Anthropic API Key')
          .then((pick) => pick && vscode.commands.executeCommand('archAnalyzer.setAnthropicKey'));
        throw new Error('No AI model available. Sign in to GitHub Copilot (or another VS Code language model provider), or run "Architecture: Set Anthropic API Key".');
      }
      throw e;
    }
  }

  private async vscodeLm(req: AIRequest): Promise<string> {
    const family = this.cfg().get<string>('vscodeModelFamily', '');
    let models = await vscode.lm.selectChatModels(family ? { family } : {});
    if (!models.length && family) models = await vscode.lm.selectChatModels({});
    if (!models.length) throw new NoModelError();
    const model = models[0];
    // The LM API has no system role; prepend instructions to the first user turn.
    const msgs = req.messages.map((m, i) =>
      m.role === 'user'
        ? vscode.LanguageModelChatMessage.User(i === 0 ? `${req.system}\n\n---\n\n${m.content}` : m.content)
        : vscode.LanguageModelChatMessage.Assistant(m.content),
    );
    const cts = new vscode.CancellationTokenSource();
    req.token?.onCancellationRequested(() => cts.cancel());
    const res = await model.sendRequest(msgs, { justification: 'Explain the architecture of this codebase using static analysis results.' }, cts.token);
    let full = '';
    for await (const chunk of res.text) {
      full += chunk;
      req.onText(chunk);
    }
    return full;
  }

  private async anthropic(req: AIRequest): Promise<string> {
    const apiKey = (await this.secrets.get(SECRET_KEY)) ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      void vscode.window.showWarningMessage('Anthropic API key not set.', 'Set Anthropic API Key').then((pick) => pick && vscode.commands.executeCommand('archAnalyzer.setAnthropicKey'));
      throw new Error('Anthropic API key not set. Run "Architecture: Set Anthropic API Key".');
    }
    const client = new Anthropic({ apiKey });
    const model = this.cfg().get<string>('anthropicModel', 'claude-opus-5-5');
    const effort = this.cfg().get<'low' | 'medium' | 'high' | 'xhigh' | 'max'>('effort', 'medium');
    // Server-side refusal fallback ("default" routing) keeps answers flowing if the primary model declines.
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort },
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    req.token?.onCancellationRequested(() => stream.abort());
    let full = '';
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          full += event.delta.text;
          req.onText(event.delta.text);
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') {
        const note = '\n\n_The model declined to answer this request._';
        full += note;
        req.onText(note);
      } else if (final.stop_reason === 'max_tokens') {
        const note = '\n\n_(response truncated: output limit reached)_';
        full += note;
        req.onText(note);
      }
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API key is invalid. Run "Architecture: Set Anthropic API Key".');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached — try again shortly.');
      if (e instanceof Anthropic.APIUserAbortError) return full;
      if (e instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${e.status ?? ''}: ${e.message}`);
      throw e;
    }
    return full;
  }
}

export class NoModelError extends Error {
  constructor() {
    super('No VS Code language model available');
  }
}
