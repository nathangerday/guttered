import { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'guttered-host-'));
const workspace = path.join(temporary, 'workspace');
const userData = path.join(temporary, 'user');
const extensions = path.join(root, '.vscode-test', 'extensions');
const withGitLens = process.env.GUTTERED_TEST_GITLENS === '1';
const withoutBuiltInGit = process.env.GUTTERED_TEST_NO_GIT === '1';

await mkdir(workspace);
await mkdir(path.join(userData, 'User'), { recursive: true });
await writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
  'window.title': 'Guttered extension tests',
  'workbench.startupEditor': 'none',
  'chat.disableAIFeatures': true,
  'gitlens.showWhatsNewAfterUpgrades': false,
  'extensions.autoUpdate': false,
  ...(withoutBuiltInGit ? { 'git.enabled': false, 'git.path': ['/missing/guttered-test-git'] } : {}),
}));
try {
  const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
  if (withGitLens) {
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { reuseMachineInstall: true });
    execFileSync(cli, [
      ...args, '--no-sandbox', '--user-data-dir', userData, '--extensions-dir', extensions,
      '--install-extension', 'eamodio.gitlens', '--force',
    ], { stdio: 'inherit' });
  }
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist', 'integration.js'),
    extensionTestsEnv: {
      GUTTERED_TEST_GITLENS: withGitLens ? '1' : '',
      GUTTERED_TEST_NO_GIT: withoutBuiltInGit ? '1' : '',
    },
    launchArgs: [
      workspace,
      ...(withGitLens ? [] : ['--disable-extensions']),
      ...(withoutBuiltInGit ? ['--disable-extension', 'vscode.git'] : []),
      '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--user-data-dir', userData, '--extensions-dir', extensions,
    ],
  });
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
