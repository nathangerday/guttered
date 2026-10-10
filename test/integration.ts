import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git, commitFile, remoteDefault } from './fixtures';
import type { Controller } from '../src/controller';
import { hunkAtLine } from '../src/diff';

let diagnostics: (() => unknown) | undefined;
let activeController: Controller;
let latestPreviewUri: vscode.Uri;

async function changePreview(document: vscode.TextDocument, line: number): Promise<string | undefined> {
  let comparison = activeController.getComparison(document.uri);
  if (!comparison || comparison.version !== document.version) comparison = await activeController.compare(document, true);
  if (!comparison || comparison.version !== document.version
    || !hunkAtLine(comparison.diff.hunks, line, document.lineCount)) return;
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  editor.selection = new vscode.Selection(line, 0, line, 0);
  const before = new Set(vscode.workspace.textDocuments.map(doc => doc.uri.toString()));
  await vscode.commands.executeCommand('guttered.peekChange');
  await waitFor(() => vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'guttered-hunk' && !before.has(doc.uri.toString())), 'inline diff preview opens');
  const preview = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'guttered-hunk' && !before.has(doc.uri.toString()))!;
  assert.equal(preview.languageId, 'diff', 'virtual previews get native diff syntax colors');
  assert.equal(editor.selection.active.line, line, 'preview preserves the source cursor');
  const text = preview.getText();
  latestPreviewUri = preview.uri;
  await vscode.commands.executeCommand('closeReferenceSearch');
  return text;
}

const unicodeCases = [
  { name: 'emoji', baseline: 'status: 👍 ok\n', current: 'status: 👎 ok\n' },
  { name: 'unicode-suffix', baseline: 'a\uD83D\uDE00b\n', current: 'a\uD83C\uDE00b\n' },
  { name: 'unicode-deletion', baseline: 'a\n👎 removed\n👍 kept\n', current: 'a\n👍 kept\n' },
];
const latin1Content = 'greeting=café\nfarewell=adieu\n';

async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeout = 12_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.error(JSON.stringify(diagnostics?.(), null, 2));
  throw new Error(`Timed out: ${description}`);
}

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  git(root, 'init', '-b', 'trunk');
  git(root, 'config', 'user.email', 'tests@example.invalid');
  git(root, 'config', 'user.name', 'Guttered Tests');
  git(root, 'config', 'commit.gpgsign', 'false');
  await commitFile(root, 'deletions.txt', 'a\nX\nb\nY\nc\n');
  await commitFile(root, 'branch-deletions.txt', 'a\nX\nb\nY\nc\n');
  for (const sample of unicodeCases) await commitFile(root, `${sample.name}.txt`, sample.baseline);
  await writeFile(path.join(root, 'latin1.properties'), Buffer.from(latin1Content, 'latin1'));
  git(root, 'add', 'latin1.properties');
  git(root, 'commit', '-m', 'Add Latin-1 fixture');
  const baseline = 'unchanged\ncommitted-base\nseparator1\nstaged-base\nseparator2\nunstaged-base\nseparator3\nunsaved-base\nend\n';
  const ancestor = await commitFile(root, 'file.txt', baseline);
  git(root, 'checkout', '-b', 'feature');
  await commitFile(root, 'branch-deletions.txt', 'a\nb\nc\n');
  const committed = baseline.replace('committed-base', 'committed-feature');
  const featureCommit = await commitFile(root, 'file.txt', committed);
  git(root, 'checkout', 'trunk');
  await commitFile(root, 'file.txt', baseline.replace('end', 'upstream-only'));
  remoteDefault(root);
  git(root, 'checkout', 'feature');
  const staged = committed.replace('staged-base', 'staged-feature');
  await writeFile(path.join(root, 'file.txt'), staged);
  git(root, 'add', 'file.txt');
  const working = staged.replace('unstaged-base', 'unstaged-feature');
  await writeFile(path.join(root, 'file.txt'), working);

  const extension = vscode.extensions.getExtension<Controller>('nathangerday.guttered');
  assert.ok(extension, 'Guttered is installed in the extension host');
  const controller = await extension.activate();
  activeController = controller;
  diagnostics = () => ({
    focused: vscode.window.state.focused,
    visible: vscode.window.visibleTextEditors.map(view => ({
      path: view.document.uri.fsPath,
      version: view.document.version,
      comparedVersion: controller.getComparison(view.document.uri)?.version,
      hunks: controller.getComparison(view.document.uri)?.diff.hunks.length,
      reason: controller.reason(view.document.uri),
    })),
  });
  if (process.env.GUTTERED_TEST_NO_GIT === '1') {
    assert.equal(vscode.workspace.getConfiguration('git').get('enabled'), false);
    const builtInGit = vscode.extensions.getExtension<{ enabled: boolean }>('vscode.git');
    assert.equal(builtInGit?.exports?.enabled ?? false, false);
  }
  if (process.env.GUTTERED_TEST_GITLENS === '1') {
    const gitlens = vscode.extensions.getExtension('eamodio.gitlens');
    assert.ok(gitlens, 'GitLens is installed');
    await gitlens.activate();
    assert.ok(gitlens.isActive, 'GitLens is active alongside Guttered');
  }
  const document = await vscode.workspace.openTextDocument(path.join(root, 'file.txt'));
  let editor = await vscode.window.showTextDocument(document, { preview: false });
  const comparison = () => controller.getComparison(document.uri);
  await waitFor(async () => {
    // GitLens may open its first-run welcome page after activation resolves.
    if (!vscode.window.visibleTextEditors.some(visible => visible.document === document)) {
      editor = await vscode.window.showTextDocument(document, { preview: false });
      return false;
    }
    return comparison()?.diff.hunks.length === 3;
  }, 'committed, staged and unstaged changes appear automatically');
  assert.equal(comparison()!.snapshot.mergeBase, ancestor);
  assert.equal(comparison()!.snapshot.baseRef, 'origin/trunk');
  assert.deepEqual(comparison()!.diff.modified.map(range => range.start), [1, 3, 5]);
  assert.deepEqual(comparison()!.markers.map(marker => marker.line), [1], 'local staged and unstaged lines have no branch markers');
  assert.ok((await changePreview(document, 3))?.includes('+staged-feature'));
  assert.ok((await changePreview(document, 5))?.includes('+unstaged-feature'));
  console.log('PASS: complete comparison includes local edits while only committed branch lines have markers');

  editor = await vscode.window.showTextDocument(document, { preview: false });
  await editor.edit(edit => edit.replace(document.lineAt(7).range, 'unsaved-feature'));
  assert.equal(document.isDirty, true);
  await waitFor(async () => {
    if (!vscode.window.visibleTextEditors.some(view => view.document === document)) {
      editor = await vscode.window.showTextDocument(document, { preview: false });
      return false;
    }
    return comparison()?.version === document.version && comparison()?.diff.hunks.length === 4;
  }, 'unsaved edits update automatically');
  editor = await vscode.window.showTextDocument(document, { preview: false });
  assert.equal((await readFile(document.uri.fsPath, 'utf8')).includes('unsaved-feature'), false);
  assert.ok((await changePreview(document, 7))?.includes('+unsaved-feature'), 'local edits remain available in the complete merge-base preview');
  assert.deepEqual(comparison()!.markers.map(marker => marker.line), [1]);
  const branchPreview = await changePreview(document, 1);
  const branchPreviewUri = latestPreviewUri;
  assert.ok(branchPreview);
  assert.ok(branchPreview.includes('-committed-base') && branchPreview.includes('+committed-feature'));
  assert.ok(branchPreview.includes(ancestor.slice(0, 8)));
  assert.equal(await changePreview(document, 0), undefined);
  const languageHover = vscode.languages.registerHoverProvider({ scheme: 'file', language: 'plaintext' }, {
    provideHover: () => new vscode.Hover('Function documentation'),
  });
  try {
    const codeHovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, new vscode.Position(1, 0));
    assert.deepEqual(codeHovers.map(hover => hover.contents), [[new vscode.MarkdownString('Function documentation')]],
      'source hover contains documentation without the branch-change preview');
    const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', document.uri, new vscode.Range(1, 0, 1, 0));
    assert.equal(hints.length, 0, 'Guttered adds no injected hint targets');
  } finally {
    languageHover.dispose();
  }
  editor = await vscode.window.showTextDocument(document, { preview: false });
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('guttered.nextChange');
  assert.equal(editor.selection.active.line, 1);
  await vscode.commands.executeCommand('guttered.nextChange');
  assert.equal(editor.selection.active.line, 3);
  await vscode.commands.executeCommand('guttered.previousChange');
  // Wait for the workbench to apply cursor navigation before the next action.
  editor = await vscode.window.showTextDocument(document, { preview: false });
  assert.equal(editor.selection.active.line, 1);
  await vscode.commands.executeCommand('guttered.restoreChange');
  assert.equal((await vscode.workspace.openTextDocument(branchPreviewUri)).getText(), branchPreview, 'opening a preview preserves its snapshot across later edits');
  assert.equal(document.lineAt(1).text, 'committed-base');
  assert.equal(document.lineAt(3).text, 'staged-feature');
  assert.equal(document.lineAt(7).text, 'unsaved-feature');
  assert.equal(git(root, 'show', ':file.txt'), staged.trim());
  await vscode.commands.executeCommand('undo');
  assert.equal(document.lineAt(1).text, 'committed-feature');
  console.log('PASS: unsaved changes, navigation, restore, Undo, and unchanged Git index');

  const beforeToggle = document.getText();
  await vscode.commands.executeCommand('guttered.toggle');
  assert.equal(controller.enabled, false);
  assert.equal(controller.getComparison(document.uri), undefined);
  assert.equal(await changePreview(document, 7), undefined);
  assert.equal(document.getText(), beforeToggle, 'toggle preserves unsaved edits');
  await vscode.commands.executeCommand('guttered.toggle');
  await waitFor(() => comparison()?.version === document.version, 'toggle restores live comparison');
  assert.equal(controller.enabled, true);
  assert.ok((await changePreview(document, 1))?.includes('+committed-feature'));
  console.log('PASS: workspace toggle removes and restores comparison and previews without changing the buffer');

  await vscode.commands.executeCommand('guttered.openDiff');
  await waitFor(() => vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'guttered-base'), 'baseline diff document opens');
  const baselineDocument = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'guttered-base')!;
  assert.equal(baselineDocument.getText(), baseline);
  assert.equal(JSON.parse(baselineDocument.uri.query).mergeBase, ancestor);
  // Explicit full-diff targets work even when another file has focus.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(root, 'deletions.txt')));
  await vscode.commands.executeCommand('guttered.openDiff', document.uri.toString(), 1);
  await waitFor(() => vscode.window.activeTextEditor?.document === document && vscode.window.activeTextEditor.selection.active.line === 1,
    'full diff opens its target document at the requested change');
  assert.equal(document.isDirty, true);
  assert.equal(document.lineAt(7).text, 'unsaved-feature');
  editor = await vscode.window.showTextDocument(document);
  console.log('PASS: inline previews preserve documentation; full native diff includes unsaved content');

  const deletionDocument = await vscode.workspace.openTextDocument(path.join(root, 'deletions.txt'));
  const deletionEditor = await vscode.window.showTextDocument(deletionDocument);
  const deletionRange = () => new vscode.Range(0, 0, deletionDocument.lineCount, 0);
  await deletionEditor.edit(edit => edit.replace(deletionRange(), 'a\nb\nc\n'));
  await waitFor(() => controller.getComparison(deletionDocument.uri)?.diff.deleted.length === 2, 'neighboring deletions appear');
  assert.ok((await changePreview(deletionDocument, 0))?.includes('-X'), 'local deletion previews remain available');
  assert.ok((await changePreview(deletionDocument, 1))?.includes('-Y'));
  assert.ok((await changePreview(deletionDocument, 2))?.includes('-Y'));
  deletionEditor.selection = new vscode.Selection(1, 0, 1, 0);
  await vscode.commands.executeCommand('guttered.restoreChange');
  assert.equal(deletionDocument.getText(), 'a\nb\nY\nc\n');
  await vscode.commands.executeCommand('undo');
  assert.equal(deletionDocument.getText(), 'a\nb\nc\n');
  await deletionEditor.edit(edit => edit.replace(deletionRange(), 'b\n'));
  await waitFor(() => controller.getComparison(deletionDocument.uri)?.version === deletionDocument.version, 'overlapping deletion markers update');
  assert.ok((await changePreview(deletionDocument, 0))?.includes('-X'));
  assert.deepEqual(controller.getComparison(deletionDocument.uri)!.markers, [], 'local deletions have no branch shading');
  await deletionEditor.edit(edit => edit.replace(deletionRange(), 'a\nX\nb\nY\nc\n'));
  await deletionDocument.save();

  const branchDeletions = await vscode.workspace.openTextDocument(path.join(root, 'branch-deletions.txt'));
  await vscode.window.showTextDocument(branchDeletions);
  await waitFor(() => controller.getComparison(branchDeletions.uri)?.version === branchDeletions.version, 'committed deletion comparison loads');
  assert.ok((await changePreview(branchDeletions, 0))?.includes('-X'));
  assert.ok((await changePreview(branchDeletions, 1))?.includes('-Y'));
  console.log('PASS: committed deletion previews remain available while local deletions have no markers');

  for (const sample of unicodeCases) {
    const unicodeDocument = await vscode.workspace.openTextDocument(path.join(root, `${sample.name}.txt`));
    const unicodeEditor = await vscode.window.showTextDocument(unicodeDocument);
    const wholeDocument = () => new vscode.Range(0, 0, unicodeDocument.lineCount, 0);
    await unicodeEditor.edit(edit => edit.replace(wholeDocument(), sample.current));
    await waitFor(() => controller.getComparison(unicodeDocument.uri)?.version === unicodeDocument.version,
      `${sample.name} comparison includes the edit`);
    unicodeEditor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand('guttered.restoreChange');
    assert.equal(unicodeDocument.getText(), sample.baseline, `${sample.name} restores intact Unicode`);
    await vscode.commands.executeCommand('undo');
    assert.equal(unicodeDocument.getText(), sample.current, `${sample.name} supports Undo`);
    assert.equal(git(root, 'show', `:${sample.name}.txt`), sample.baseline.trim());
    await unicodeEditor.edit(edit => edit.replace(wholeDocument(), sample.baseline));
    await unicodeDocument.save();
  }
  console.log('PASS: Unicode modifications and deletions restore without splitting surrogate pairs, with Undo');

  editor = await vscode.window.showTextDocument(document, { preview: false });
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  await waitFor(() => vscode.window.visibleTextEditors.filter(view => view.document === document).length === 2, 'same document shown in split editors');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  editor = await vscode.window.showTextDocument(document, { preview: false });
  console.log('PASS: selecting the correct deletion, Undo, and split editors');

  // Polling intentionally pauses in background windows. Bring this isolated
  // test window forward before verifying reference changes.
  if (!vscode.window.state.focused && (await vscode.commands.getCommands(true)).includes('workbench.action.focusWindow')) {
    await vscode.commands.executeCommand('workbench.action.focusWindow');
  }
  await waitFor(() => vscode.window.state.focused, 'test window gains focus');

  // Simulates refs updated by fetch while the editor still has unsaved text.
  let comparisonEvents = 0;
  const comparisonListener = controller.onDidChangeComparison(() => comparisonEvents++);
  git(root, 'update-ref', 'refs/remotes/origin/trunk', featureCommit);
  await waitFor(() => comparison()?.snapshot.mergeBase === featureCommit && comparison()?.diff.hunks.length === 3, 'ref updates are detected without refresh');
  assert.ok(comparisonEvents > 0, 'reference changes notify comparison consumers without a document edit');
  assert.equal(await changePreview(document, 1), undefined, 'a change now in the merge base loses its preview');
  git(root, 'fetch', 'origin');
  await waitFor(() => comparison()?.snapshot.mergeBase === ancestor, 'git fetch recalculates the merge base');
  assert.ok((await changePreview(document, 1))?.includes('-committed-base'), 'fetch restores the preview from the new baseline');
  comparisonListener.dispose();
  await document.save();
  git(root, 'checkout', '-f', 'trunk');
  await waitFor(() => comparison()?.snapshot.branch === 'trunk' && comparison()?.diff.hunks.length === 0, 'branch switch updates comparisons automatically');
  git(root, 'checkout', 'feature');
  await waitFor(() => comparison()?.snapshot.branch === 'feature' && comparison()?.diff.hunks.length === 1, 'switching back shows committed feature changes');
  git(root, 'rebase', 'trunk');
  // Git refs and VS Code's reloaded file contents arrive in separate events.
  await waitFor(() => comparison()?.snapshot.mergeBase === git(root, 'rev-parse', 'trunk')
    && comparison()?.diff.hunks.length === 1, 'rebase updates the merge base and editor contents');
  git(root, 'reset', '--hard', 'trunk');
  await waitFor(() => comparison()?.diff.hunks.length === 0, 'reset clears decorations automatically');
  console.log('PASS: automatic fetch, branch switch, rebase and reset updates');

  const linked = path.join(root, 'linked-worktree');
  git(root, 'worktree', 'add', '-b', 'linked-test', linked);
  const gitfile = await vscode.workspace.openTextDocument(path.join(linked, '.git'));
  const pointer = gitfile.getText();
  await vscode.window.showTextDocument(gitfile);
  await waitFor(() => !!controller.reason(gitfile.uri), 'linked worktree Git metadata is excluded');
  assert.equal(controller.getComparison(gitfile.uri), undefined);
  await vscode.commands.executeCommand('guttered.restoreChange');
  assert.equal(gitfile.getText(), pointer);
  assert.equal(gitfile.isDirty, false);
  assert.equal(await readFile(gitfile.uri.fsPath, 'utf8'), pointer);
  assert.equal(git(linked, 'rev-parse', '--is-inside-work-tree'), 'true');
  console.log('PASS: linked worktree .git pointer cannot be compared or restored');

  const latin1Uri = vscode.Uri.file(path.join(root, 'latin1.properties'));
  const fileSettings = vscode.workspace.getConfiguration('files', latin1Uri);
  const previousEncoding = fileSettings.inspect<string>('encoding')?.workspaceFolderValue;
  await fileSettings.update('encoding', 'iso88591', vscode.ConfigurationTarget.WorkspaceFolder);
  try {
    const latin1Document = await vscode.workspace.openTextDocument(latin1Uri);
    const latin1Editor = await vscode.window.showTextDocument(latin1Document);
    assert.equal(latin1Document.getText(), latin1Content, 'VS Code decoded the Latin-1 file correctly');
    await latin1Editor.edit(edit => edit.replace(latin1Document.lineAt(1).range, 'farewell=edited'));
    const edited = latin1Content.replace('adieu', 'edited');
    await waitFor(() => /not valid UTF-8/.test(controller.reason(latin1Uri) ?? ''), 'invalid UTF-8 baseline is skipped');
    assert.equal(controller.getComparison(latin1Uri), undefined);
    latin1Editor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand('guttered.restoreChange');
    assert.equal(latin1Document.getText(), edited, 'Restore leaves the edit and untouched accented text intact');
    assert.deepEqual(await readFile(latin1Uri.fsPath), Buffer.from(latin1Content, 'latin1'));
    await latin1Document.save();
    assert.deepEqual(await readFile(latin1Uri.fsPath), Buffer.from(edited, 'latin1'), 'saving preserves the original encoding');
  } finally {
    await fileSettings.update('encoding', previousEncoding, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  console.log('PASS: Latin-1 comparison is inactive and Restore preserves both the buffer and saved characters');

  await writeFile(path.join(root, 'untracked.txt'), '');
  const newDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'untracked.txt')));
  const newEditor = await vscode.window.showTextDocument(newDocument);
  await newEditor.edit(edit => edit.insert(new vscode.Position(0, 0), 'new\nfile\n'));
  await waitFor(() => controller.getComparison(newDocument.uri)?.diff.added[0]?.count === 2, 'new unsaved file is all added');
  assert.equal(controller.getComparison(newDocument.uri)!.baselineExists, false);
  assert.ok((await changePreview(newDocument, 0))?.includes('+new'), 'new uncommitted files remain available in previews');
  assert.deepEqual(controller.getComparison(newDocument.uri)!.markers, []);

  const config = vscode.workspace.getConfiguration('guttered', newDocument.uri);
  await config.update('gutter', false, vscode.ConfigurationTarget.WorkspaceFolder);
  assert.ok((await changePreview(newDocument, 0))?.includes('+new'), 'preview commands work when shading is disabled');
  await config.update('gutter', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update('maxFileSizeKB', 1, vscode.ConfigurationTarget.WorkspaceFolder);
  await newEditor.edit(edit => edit.insert(new vscode.Position(0, 0), 'x'.repeat(2048)));
  await waitFor(() => /size/i.test(controller.reason(newDocument.uri) ?? ''), 'large file limit is applied');
  assert.equal(controller.getComparison(newDocument.uri), undefined);
  await config.update('maxFileSizeKB', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  await waitFor(() => !!controller.getComparison(newDocument.uri), 'comparison resumes after raising the size limit');
  await config.update('enabled', false, vscode.ConfigurationTarget.WorkspaceFolder);
  await waitFor(() => /disabled/.test(controller.reason(newDocument.uri) ?? ''), 'disabled settings remove the comparison');
  assert.equal(await changePreview(newDocument, 0), undefined);
  await config.update('enabled', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  await waitFor(() => !!controller.getComparison(newDocument.uri), 'reenabling resumes automatically');
  console.log('PASS: untracked unsaved files, large file limits and live configuration');

  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(root, 'ignored.txt'), 'generated\n');
  const ignoredDocument = await vscode.workspace.openTextDocument(path.join(root, 'ignored.txt'));
  await vscode.window.showTextDocument(ignoredDocument);
  await waitFor(() => /ignored by Git/.test(controller.reason(ignoredDocument.uri) ?? ''), 'ignored file has no comparison');
  await writeFile(path.join(root, '.gitignore'), '');
  await waitFor(() => controller.getComparison(ignoredDocument.uri)?.diff.added.length === 1, 'changing ignore rules resumes comparison without editing the file');
  console.log('PASS: ignored files and automatic ignore-rule updates');


  // A second repository in the same workspace must retain its own default branch.
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  await writeFile(path.join(nested, 'nested.txt'), 'base\n');
  const nestedDoc = await vscode.workspace.openTextDocument(path.join(nested, 'nested.txt'));
  await vscode.window.showTextDocument(nestedDoc, vscode.ViewColumn.Beside);
  await waitFor(() => controller.getComparison(nestedDoc.uri)?.snapshot.root === root, 'folder initially belongs to parent repository');
  git(nested, 'init', '-b', 'release');
  git(nested, 'config', 'user.email', 'tests@example.invalid');
  git(nested, 'config', 'user.name', 'Guttered Tests');
  git(nested, 'config', 'commit.gpgsign', 'false');
  await commitFile(nested, 'nested.txt', 'base\n');
  remoteDefault(nested, 'release');
  git(nested, 'checkout', '-b', 'nested-feature');
  await commitFile(nested, 'nested.txt', 'feature\n');
  await waitFor(() => controller.getComparison(nestedDoc.uri)?.snapshot.baseRef === 'origin/release', 'nested repository has independent default branch');
  assert.equal(controller.getComparison(nestedDoc.uri)!.diff.modified.length, 1);
  console.log('PASS: nested repository discovery and simultaneous editors');
  await rm(path.join(root, '.vscode'), { recursive: true, force: true });
  console.log(`Guttered integration tests passed${process.env.GUTTERED_TEST_GITLENS === '1' ? ' with GitLens active' : ''}.`);
}
