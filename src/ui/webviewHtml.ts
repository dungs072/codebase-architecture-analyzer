import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function webviewHtml(webview: vscode.Webview, extUri: vscode.Uri, title: string, scripts: string[], styles: string[]): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', ...p.split('/')));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
${styles.map((s) => `<link rel="stylesheet" href="${uri(s)}">`).join('\n')}
</head>
<body>
<div id="app"></div>
${scripts.map((s) => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('\n')}
</body>
</html>`;
}
