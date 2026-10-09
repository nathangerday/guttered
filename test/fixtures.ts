import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guttered-'));
  git(root, 'init', '-b', 'trunk');
  git(root, 'config', 'user.email', 'tests@example.invalid');
  git(root, 'config', 'user.name', 'Guttered Tests');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}
export async function commitFile(root: string, file: string, text: string): Promise<string> {
  await writeFile(path.join(root, file), text);
  git(root, 'add', '--', file);
  git(root, 'commit', '-m', `Update ${file}`);
  return git(root, 'rev-parse', 'HEAD');
}
export function remoteDefault(root: string, branch = 'trunk'): void {
  git(root, 'remote', 'add', 'origin', root);
  git(root, 'update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`);
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`);
}
