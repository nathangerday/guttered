import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Git, GitService } from '../src/git';
import { computeDiff } from '../src/diff';
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
  const ancestor = await commitFile(root, 'file.txt', 'first\nshared\nlast\n');
  remoteDefault(root);
  const located = (await service.locate(path.join(root, 'file.txt')))!;
  return { root, service, ancestor, repo: located.repository };
}

test('branch choices include local and remote refs, exclude aliases and tags, and avoid ambiguous names', async () => {
  const { root, repo, ancestor } = await setup();
  git(root, 'checkout', '-b', 'feature/topic');
  const feature = await commitFile(root, 'feature.txt', 'feature\n');
  git(root, 'branch', 'origin/trunk');
  git(root, 'tag', 'origin/trunk');
  git(root, 'tag', 'release-tag');
  git(root, 'update-ref', 'refs/remotes/upstream/release', feature);
  const branches = await repo.branches();
  assert.deepEqual(branches, [
    { name: 'feature/topic', ref: 'refs/heads/feature/topic' },
    { name: 'origin/trunk', ref: 'refs/heads/origin/trunk' },
    { name: 'trunk', ref: 'refs/heads/trunk' },
    { name: 'origin/trunk', ref: 'refs/remotes/origin/trunk' },
    { name: 'upstream/release', ref: 'refs/remotes/upstream/release' },
  ]);
  const remote = await repo.snapshot(branches[3]!.ref);
  assert.equal(remote.mergeBase, ancestor, 'a selected remote branch cannot resolve to the same-named local branch or tag');
  assert.equal(remote.baseRef, 'origin/trunk');
  const local = await repo.snapshot(branches[1]!.ref);
  assert.equal(local.mergeBase, feature);
  git(root, 'branch', 'new-branch');
  assert.ok((await repo.branches()).some(branch => branch.name === 'new-branch'), 'reopening the picker reads fresh branch refs');
});

test('default branch detection does not assume master/main, and excludes upstream-only changes', async () => {
  const { root, service, ancestor, repo } = await setup();
  git(root, 'checkout', '-b', 'feature');
  await commitFile(root, 'file.txt', 'first\nfeature\nlast\n');
  git(root, 'checkout', 'trunk');
  await commitFile(root, 'file.txt', 'upstream-only\nshared\nlast\n');
  git(root, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  git(root, 'checkout', 'feature');
  const snapshot = await repo.snapshot('');
  assert.equal(snapshot.mergeBase, ancestor);
  assert.equal(snapshot.baseRef, 'origin/trunk');
  assert.notEqual(snapshot.baseTip, ancestor);
  const baseline = await service.baseline(snapshot, 'file.txt', 1024);
  const diff = computeDiff(baseline.text, 'first\nfeature\nlast\n');
  assert.deepEqual(diff.modified, [{ start: 1, count: 1 }]);
  assert.equal(await repo.snapshot(''), snapshot);
  assert.equal(await service.baseline(snapshot, 'file.txt', 1024), baseline);
});

test('staged, unstaged, unsaved and untracked content uses the same baseline', async () => {
  const { root, service, repo } = await setup();
  git(root, 'checkout', '-b', 'feature');
  await commitFile(root, 'file.txt', 'committed\nshared\nlast\n');
  await writeFile(path.join(root, 'file.txt'), 'committed\nstaged\nlast\n');
  git(root, 'add', 'file.txt');
  await writeFile(path.join(root, 'file.txt'), 'committed\nstaged\nunstaged\n');
  const snapshot = await repo.snapshot('');
  const baseline = await service.baseline(snapshot, 'file.txt', 1024);
  const diff = computeDiff(baseline.text, 'committed\nstaged\nunstaged\nunsaved\n');
  assert.deepEqual(diff.modified, [{ start: 0, count: 3 }]);
  assert.deepEqual(diff.added, [{ start: 3, count: 1 }]);
  assert.deepEqual(await service.baseline(snapshot, 'untracked.txt', 1024), { text: '', exists: false, bytes: 0 });
});

test('ref updates and branch switches recalculate the merge base', async () => {
  const { root, repo, ancestor } = await setup();
  git(root, 'checkout', '-b', 'feature');
  const feature = await commitFile(root, 'feature.txt', 'feature\n');
  const initial = await repo.snapshot('');
  assert.equal(initial.mergeBase, ancestor);
  git(root, 'update-ref', 'refs/remotes/origin/trunk', feature);
  const updated = await repo.snapshot('', true);
  assert.equal(updated.mergeBase, feature);
  git(root, 'checkout', 'trunk');
  const switched = await repo.snapshot('', true);
  assert.equal(switched.mergeBase, ancestor);
  assert.equal(switched.branch, 'trunk');
});

test('uses remote HEAD discovery when symbolic tracking HEAD is absent, then local fallback', async () => {
  const { root, repo } = await setup();
  git(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  const snapshot = await repo.snapshot('');
  assert.equal(snapshot.baseRef, 'origin/trunk');
  git(root, 'update-ref', '-d', 'refs/remotes/origin/trunk');
  assert.equal((await repo.snapshot('', true)).baseRef, 'trunk');
});

test('supports a non-origin remote, explicit overrides, and detached HEAD', async () => {
  const { root, repo, ancestor } = await setup();
  git(root, 'remote', 'rename', 'origin', 'upstream');
  git(root, 'checkout', '--detach', ancestor);
  assert.equal((await repo.snapshot('')).baseRef, 'upstream/trunk');
  const snapshot = await repo.snapshot('trunk');
  assert.match(snapshot.branch, /Detached HEAD/);
  assert.equal(snapshot.mergeBase, ancestor);
  await assert.rejects(repo.snapshot('missing-branch'), /unavailable/);
});

test('linked worktrees, nested repositories, literal paths and nonexistent directories', async () => {
  const { root, service, repo } = await setup();
  const worktree = `${root}-linked`; roots.push(worktree);
  git(root, 'worktree', 'add', '-b', 'linked', worktree);
  const linked = await service.locate(path.join(worktree, 'file.txt'));
  assert.equal(linked?.repository.root, worktree);
  assert.equal((await linked!.repository.snapshot('')).branch, 'linked');
  assert.equal(await service.locate(path.join(worktree, '.git')), undefined);
  const filename = 'odd [name] $file.txt';
  await commitFile(root, filename, 'literal\n');
  const snapshot = await repo.snapshot('HEAD', true);
  assert.equal((await service.baseline(snapshot, filename, 1024)).text, 'literal\n');
  assert.equal((await service.locate(path.join(root, 'not-created', 'new.txt')))?.path, 'not-created/new.txt');
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  git(nested, 'init', '-b', 'custom');
  assert.equal((await service.locate(path.join(nested, 'new.txt')))?.repository.root, nested);
});

test('size limits, binary files and Git errors are not mistaken for added files', async () => {
  const { root, service, repo } = await setup();
  await commitFile(root, 'binary', 'hello\0world');
  const snapshot = await repo.snapshot('HEAD');
  await assert.rejects(service.baseline(snapshot, 'binary', 1024), /binary/);
  await assert.rejects(service.baseline(snapshot, 'file.txt', 2), /size/i);
  await service.baseline(snapshot, 'file.txt', 1024);
  await assert.rejects(service.baseline(snapshot, 'file.txt', 2), /size/i);
  await assert.rejects(service.baseline({ root, mergeBase: 'deadbeef' }, 'file.txt', 1024));
});

test('invalid UTF-8 baselines are rejected while Unicode, BOMs, and literal replacement characters remain valid', async () => {
  const { root, service, repo } = await setup();
  await writeFile(path.join(root, 'latin1.properties'), Buffer.from('greeting=café\nfarewell=adieu\n', 'latin1'));
  await writeFile(path.join(root, 'truncated.txt'), Buffer.from([0x61, 0xf0, 0x9f, 0x91]));
  git(root, 'add', 'latin1.properties', 'truncated.txt');
  git(root, 'commit', '-m', 'Add files with invalid UTF-8 bytes');
  const unicode = '\uFEFFgreeting=café 👍\nliteral=�\n';
  await commitFile(root, 'utf8.txt', unicode);
  const snapshot = await repo.snapshot('HEAD');
  await assert.rejects(service.baseline(snapshot, 'latin1.properties', 1024), /not valid UTF-8/);
  await assert.rejects(service.baseline(snapshot, 'truncated.txt', 1024), /not valid UTF-8/);
  const decoded = await service.baseline(snapshot, 'utf8.txt', 1024);
  assert.equal(decoded.text, unicode.slice(1));
  assert.equal(decoded.bytes, Buffer.byteLength(unicode));
});

test('no remote and unborn or unrelated histories have actionable inactive states', async () => {
  const root = await repository(); roots.push(root);
  const service = new GitService(); services.push(service);
  const repo = (await service.locate(path.join(root, 'file.txt')))!.repository;
  await assert.rejects(repo.snapshot('HEAD'), /no HEAD commit/);
  await commitFile(root, 'file.txt', 'a');
  await assert.rejects(repo.snapshot(''), /No remote default branch/);
  git(root, 'checkout', '--orphan', 'unrelated');
  git(root, 'commit', '-m', 'unrelated');
  await assert.rejects(repo.snapshot('trunk'), /no common ancestor/);
});

test('automatic defaults use the remote ref even when a local branch and tag shadow it', async () => {
  const { root, repo, ancestor } = await setup();
  git(root, 'checkout', '-b', 'feature');
  await commitFile(root, 'file.txt', 'feature\n');
  git(root, 'branch', 'origin/trunk');
  git(root, 'tag', 'origin/trunk');
  const snapshot = await repo.snapshot('');
  assert.equal(snapshot.mergeBase, ancestor);
  assert.equal(snapshot.baseRef, 'origin/trunk');
});

test('refreshing discovery finds a repository created in a previously opened folder', async () => {
  const { root, service } = await setup();
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  const file = path.join(nested, 'file.txt');
  assert.equal((await service.locate(file))?.repository.root, root);
  git(nested, 'init', '-b', 'nested-default');
  service.resetDiscovery();
  assert.equal((await service.locate(file))?.repository.root, nested);
  assert.equal(await service.locate(path.join(root, '.git', 'COMMIT_EDITMSG')), undefined);
});

test('git.path candidate arrays try usable executables in order', async () => {
  const client = new Git(['/does-not-exist/guttered-git', 'git']);
  try {
    assert.match(await client.text(process.cwd(), ['--version']), /^git version /);
  } finally {
    client.dispose();
  }
});

test('invalid Git paths fall back to an absolute PATH executable and keep using it', async t => {
  const { root } = await setup();
  const originalPath = process.env.PATH;
  const client = new Git([path.join(root, 'missing-git')]);
  const execution = t.mock.method(client as unknown as {
    execute(executable: string, root: string, args: string[], maxBuffer: number): Promise<Buffer>;
  }, 'execute');
  try {
    // Empty and relative entries must not select an executable from a repository.
    process.env.PATH = ['', '.', 'relative-bin', originalPath ?? ''].join(path.delimiter);
    const version = await client.text(root, ['--version']);
    assert.match(version, /^git version /);
    const probes = execution.mock.calls.filter(call => call.arguments[2][0] === '--version');
    assert.ok(probes.length > 1, 'the invalid configured path was tried before PATH');
    for (const call of execution.mock.calls) assert.ok(path.isAbsolute(call.arguments[0]));
    const selected = execution.mock.calls.at(-1)!.arguments[0];
    // Later repository commands use the resolved path, even if PATH changes.
    process.env.PATH = '';
    assert.equal(await client.text(root, ['--version']), version);
    assert.equal(execution.mock.calls.at(-1)!.arguments[0], selected);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    client.dispose();
  }
});

test('remote HEAD failures are cached until expiry or an explicit refresh', async t => {
  const { root, service, repo } = await setup();
  git(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  git(root, 'remote', 'set-url', 'origin', path.join(root, 'missing-remote'));
  const run = t.mock.method(service.git, 'run');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const lookups = () => run.mock.calls.filter(call => call.arguments[1][0] === 'ls-remote').length;
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(repo.snapshot('', true), (error: Error) => {
      assert.match(error.message, /Cannot detect origin's default branch/);
      assert.match(error.message, /Guttered: Refresh Comparison/);
      assert.match(error.message, /Base Reference to a locally available branch/);
      assert.match(error.message, /missing-remote/);
      return true;
    });
    now += 4_000;
  }
  assert.equal(lookups(), 1);
  assert.equal((await repo.snapshot('trunk')).baseRef, 'trunk');
  assert.equal(lookups(), 1, 'an explicit local reference works without contacting the remote');
  now += 5 * 60_000;
  await assert.rejects(repo.snapshot('', true));
  assert.equal(lookups(), 2);
  git(root, 'remote', 'set-url', 'origin', root);
  service.clearTransientCaches();
  assert.equal((await repo.snapshot('', true)).baseRef, 'origin/trunk');
  assert.equal(lookups(), 3);
});

test('ignore rules refresh independently of immutable baselines and respect force-added files', async () => {
  const { root, service, repo } = await setup();
  await writeFile(path.join(root, '.gitignore'), 'generated.txt\n');
  await writeFile(path.join(root, 'generated.txt'), 'generated\n');
  assert.equal(await repo.isIgnored('generated.txt'), true);
  await writeFile(path.join(root, '.gitignore'), '');
  service.resetDiscovery();
  assert.equal(await repo.isIgnored('generated.txt'), false);
  await writeFile(path.join(root, '.gitignore'), 'generated.txt\n');
  git(root, 'add', '-f', 'generated.txt');
  service.resetDiscovery();
  assert.equal(await repo.isIgnored('generated.txt'), false);
});

test('baseline reads include nested paths', async () => {
  const { root, repo, service } = await setup();
  await mkdir(path.join(root, 'src'));
  await commitFile(root, 'src/deep.txt', 'nested baseline\n');
  const snapshot = await repo.snapshot('HEAD');
  assert.equal((await service.baseline(snapshot, 'src/deep.txt', 1024)).text, 'nested baseline\n');
});
