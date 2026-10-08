// Runs inside the extension host (see runIntegration.js).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (cond, msg) => {
  results.push(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) process.exitCode = 1;
};

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return undefined;
}

exports.run = async function () {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'codebase-architecture-analyzer');
  check(!!ext, 'extension found');
  await ext.activate();
  check(ext.isActive, 'extension activated');

  const cmds = await vscode.commands.getCommands(true);
  const declared = ext.packageJSON.contributes.commands.map((c) => c.command);
  const missing = declared.filter((c) => !cmds.includes(c));
  check(missing.length === 0, `all ${declared.length} contributed commands registered${missing.length ? ' — missing: ' + missing.join(', ') : ''}`);

  await vscode.commands.executeCommand('archAnalyzer.analyze');
  let diag = await vscode.commands.executeCommand('archAnalyzer._diagnostics');
  check(diag.hasModel && diag.types > 10, `analysis produced a model (${diag.types} types)`);

  await vscode.commands.executeCommand('archAnalyzer.openGraph');
  diag = await waitFor(async () => {
    const d = await vscode.commands.executeCommand('archAnalyzer._diagnostics');
    return d.lastRender ? d : undefined;
  });
  check(!!diag?.lastRender && diag.lastRender.nodes >= 5, `architecture map rendered ${diag?.lastRender?.nodes} nodes / ${diag?.lastRender?.edges} edges`);

  const farm = 'Assets/Game/Farming/FarmManager.cs#Game.Farming.FarmManager';
  await vscode.commands.executeCommand('archAnalyzer.inspectSymbol', { symbolId: farm });
  await sleep(800);
  const afterInspect = await vscode.commands.executeCommand('archAnalyzer._diagnostics');
  check(afterInspect.lastRender.nodes > diag.lastRender.nodes, `inspecting a class expanded its module (${afterInspect.lastRender.nodes} nodes)`);

  await vscode.commands.executeCommand('archAnalyzer.showCallees', { symbolId: 'Assets/Game/UI/FarmScreen.cs#Game.UI.FarmController.Plant(2)' });
  await vscode.commands.executeCommand('archAnalyzer.showCallers', { symbolId: 'Assets/Game/Farming/CropService.cs#Game.Farming.CropService.Plant(2)' });
  // AI calls fail fast without a model provider; they must not hang or throw out of the command.
  const t0 = Date.now();
  await vscode.commands.executeCommand('archAnalyzer.traceFeature', 'hiring staff');
  await vscode.commands.executeCommand('archAnalyzer.analyzeImpact', { symbolId: 'Assets/Game/Farming/CropService.cs#Game.Farming.CropService' });
  await vscode.commands.executeCommand('archAnalyzer.explainSymbol', { symbolId: farm });
  check(Date.now() - t0 < 20000, `feature trace / impact / explain completed without hanging (${Date.now() - t0} ms)`);

  await vscode.commands.executeCommand('archAnalyzer.chat');
  diag = await vscode.commands.executeCommand('archAnalyzer._diagnostics');
  check(diag.chatOpen, 'chat panel opens');

  await sleep(1500);
  diag = await vscode.commands.executeCommand('archAnalyzer._diagnostics');
  check(diag.webviewErrors.length === 0, `no webview script errors${diag.webviewErrors.length ? ': ' + diag.webviewErrors.join(' | ') : ''}`);

  // Incremental re-analysis on save
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = path.join(root, 'Assets/Game/Core/Added.cs');
  fs.writeFileSync(file, 'namespace Game.Core { public class AddedLater { } }');
  try {
    await vscode.commands.executeCommand('archAnalyzer.analyze');
    diag = await vscode.commands.executeCommand('archAnalyzer._diagnostics');
    check(diag.types === afterInspect.types + 1 || diag.types > afterInspect.types, `incremental re-analysis picked up a new file (${afterInspect.types} → ${diag.types} types)`);
  } finally {
    fs.rmSync(file, { force: true });
  }

  console.log('\nIntegration results:\n  ' + results.join('\n  '));
};
