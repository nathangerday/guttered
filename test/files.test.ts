import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileTree, includeUnsaved } from '../src/files';
import { GitService } from '../src/git';
import { commitFile, git, remoteDefault, repository } from './fixtures';

const roots: string[] = [];
const services: GitService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await repository(); roots.push(root);
  const service = new GitService(); services.push(service);
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'docs'));
  await commitFile(root, 'src/app.ts', 'base\n');
  await commitFile(root, 'docs/notes.md', 'notes\n');
  await commitFile(root, 'docs/remove.md', 'removed\n');
  await commitFile(root, '.gitignore', 'ignored.txt\n');
  remoteDefault(root);
  const repo = (await service.locate(path.join(root, 'src/app.ts')))!.repository;
  return { root, service, repo };
}

test('changed-file listing uses the merge base and includes committed, staged, unstaged, deleted and untracked paths', async () => {
  const { root, repo } = await setup();
  git(root, 'checkout', '-b', 'feature');
  await commitFile(root, 'src/app.ts', 'feature\n');
  git(root, 'rm', 'docs/remove.md');
  git(root, 'commit', '-m', 'Remove document');
  git(root, 'checkout', 'trunk');
  await commitFile(root, 'docs/upstream-only.md', 'upstream\n');
  git(root, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  git(root, 'checkout', 'feature');
  await writeFile(path.join(root, 'docs/staged.md'), 'staged\n');
  git(root, 'add', 'docs/staged.md');
  await writeFile(path.join(root, 'docs/notes.md'), 'working\n');
  await writeFile(path.join(root, 'ignored.txt'), 'ignored\n');
  const oddName = 'src/quote " tab\t newline\n.ts';
  await writeFile(path.join(root, oddName), 'untracked\n');
  const snapshot = await repo.snapshot('');
  const files = await repo.changedFiles(snapshot.mergeBase);
  assert.deepEqual(files.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'docs/notes.md', status: 'M' },
    { path: 'docs/remove.md', status: 'D' },
    { path: 'docs/staged.md', status: 'A' },
    { path: 'src/app.ts', status: 'M' },
    { path: oddName, status: 'A' },
  ].sort((a, b) => a.path.localeCompare(b.path)));
  git(root, 'mv', 'docs/notes.md', 'docs/renamed.md');
  const renamed = await repo.changedFiles(snapshot.mergeBase);
  assert.ok(renamed.some(file => file.path === 'docs/notes.md' && file.status === 'D'));
  assert.ok(renamed.some(file => file.path === 'docs/renamed.md' && file.status === 'A'));
});

test('unsaved buffers replace disk changes, omit ignored files, and normalize CRLF without hiding final-newline edits', async () => {
  const { root, service, repo } = await setup();
  await writeFile(path.join(root, 'src/app.ts'), 'disk edit\n');
  const snapshot = await repo.snapshot('');
  const disk = await repo.changedFiles(snapshot.mergeBase);
  const files = await includeUnsaved(service, repo, snapshot, disk, [
    { path: 'src/app.ts', text: 'base\r\n', maxBytes: 1024 },
    { path: 'docs/notes.md', text: 'unsaved', maxBytes: 1024 },
    { path: 'src/new.ts', text: '', maxBytes: 1024 },
    { path: 'ignored.txt', text: 'ignored edit\n', maxBytes: 1024 },
  ]);
  assert.deepEqual(files, [{ path: 'docs/notes.md', status: 'M' }, { path: 'src/new.ts', status: 'A' }]);
  const finalNewline = await includeUnsaved(service, repo, snapshot, [], [{ path: 'src/app.ts', text: 'base', maxBytes: 1024 }]);
  assert.deepEqual(finalNewline, [{ path: 'src/app.ts', status: 'M' }]);
  const large = await includeUnsaved(service, repo, snapshot, [{ path: 'src/large.ts', status: 'A' }], [
    { path: 'ignored.txt', text: 'x'.repeat(2048), maxBytes: 1024 },
    { path: 'src/large.ts', text: 'x'.repeat(2048), maxBytes: 1024 },
  ]);
  assert.deepEqual(large, [{ path: 'src/large.ts', status: 'A' }], 'file-size limits do not bring ignored buffers into the tree');
  assert.equal(await service.git.text(root, ['show', ':src/app.ts']), 'base', 'listing never changes the index');
  assert.equal(await service.git.text(root, ['show', 'HEAD:src/app.ts']), 'base');
});

test('file tree keeps only relevant parent folders, sorts folders first, and handles a file replaced by a folder', () => {
  assert.deepEqual(fileTree([
    { path: 'src/nested/change.ts', status: 'M' },
    { path: 'src/new.ts', status: 'A' },
    { path: 'README.md', status: 'M' },
    { path: 'src', status: 'D' },
  ]), [
    { path: 'src', children: [
      { path: 'src/nested', children: [{ path: 'src/nested/change.ts', status: 'M', children: [] }] },
      { path: 'src/new.ts', status: 'A', children: [] },
    ] },
    { path: 'README.md', status: 'M', children: [] },
    { path: 'src', status: 'D', children: [] },
  ]);
  assert.deepEqual(fileTree([]), []);
});
