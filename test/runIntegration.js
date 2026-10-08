// Boots a real VS Code extension host on the Unity fixture and drives the extension's commands.
// Usage: npm run test:integration
const path = require('path');
const { runTests } = require('@vscode/test-electron');

// When launched from a terminal inside VS Code, this variable makes the test instance start as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const root = path.resolve(__dirname, '..');
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'integration.js'),
      launchArgs: [path.join(root, 'test-fixtures', 'unity-farm'), '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
    });
  } catch (e) {
    console.error('Integration tests failed', e);
    process.exit(1);
  }
})();
