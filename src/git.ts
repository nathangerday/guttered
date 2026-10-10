import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT_RETRY_MS = 3_000;
const REMOTE_HEAD_CACHE_MS = 5 * 60_000;
const BASELINE_CACHE_BYTES = 16 * 1024 * 1024;
const BASELINE_CACHE_ENTRIES = 256;

export interface Snapshot {
  root: string;
  head: string;
  branch: string;
  baseRef: string;
  baseTip: string;
  mergeBase: string;
  key: string;
}
export interface Baseline { text: string; exists: boolean; bytes: number }
export interface Branch { name: string; ref: string }
interface BaseCandidate { ref: string; label: string }

class GitError extends Error {
  constructor(message: string, readonly code: number | string | undefined) {
    super(message);
  }
}

export class Git {
  private readonly abort = new AbortController();
  private executable?: Promise<string>;

  constructor(private readonly configuredPaths: string | string[] = 'git') {}

  private execute(executable: string, root: string, args: string[], maxBuffer: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(executable, ['--no-pager', ...args], {
        cwd: root,
        encoding: 'buffer',
        maxBuffer,
        timeout: 10_000,
        signal: this.abort.signal,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' },
      }, (error, stdout, stderr) => {
        if (error) reject(new GitError(stderr.toString().trim() || error.message, error.code ?? undefined));
        else resolve(stdout);
      });
    });
  }

  private async selectExecutable(): Promise<string> {
    const configured = typeof this.configuredPaths === 'string' ? [this.configuredPaths] : this.configuredPaths;
    for (const candidate of new Set([...configured, 'git'])) {
      if (!candidate) continue;
      const hasPath = path.isAbsolute(candidate) || candidate.includes('/') ||
        (process.platform === 'win32' && candidate.includes('\\'));
      const name = process.platform === 'win32' && !path.extname(candidate) ? `${candidate}.exe` : candidate;
      // Resolve bare names once. Windows otherwise searches each repository's
      // working directory before PATH. Skip empty/relative PATH entries too.
      const paths = hasPath ? [path.resolve(candidate)] : (process.env.PATH ?? '').split(path.delimiter)
        .map(directory => directory.replace(/^"(.*)"$/, '$1'))
        .filter(directory => path.isAbsolute(directory))
        .map(directory => path.join(directory, name));
      for (const executable of paths) {
        try {
          const version = await this.execute(executable, process.cwd(), ['--version'], 4096);
          if (version.toString().startsWith('git version ')) return executable;
        } catch {
          // Try the remaining configured paths, then Git on PATH.
        }
      }
    }
    throw new Error('Git is unavailable. Install Git or check the git.path setting, then reload the window.');
  }

  async run(root: string, args: string[], maxBuffer = 1024 * 1024): Promise<Buffer> {
    this.executable ??= this.selectExecutable();
    return this.execute(await this.executable, root, args, maxBuffer);
  }

  async text(root: string, args: string[]): Promise<string> {
    return (await this.run(root, args)).toString('utf8').replace(/\r?\n$/, '');
  }

  // The callers use commands where exit 1 means "no result": quiet ref lookup,
  // symbolic-ref, merge-base, and check-ignore. Other failures must still surface.
  async optional(root: string, args: string[]): Promise<string | undefined> {
    try {
      return await this.text(root, args);
    } catch (error) {
      if (error instanceof GitError && error.code === 1) return undefined;
      throw error;
    }
  }

  dispose(): void { this.abort.abort(); }
}

export class Repository {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Promise<Snapshot>>();
  private readonly failures = new Map<string, { error: unknown; expires: number }>();
  private readonly ignored = new Map<string, Promise<boolean>>();
  private remoteHeadCache?: { remote: string; expires: number; result: Promise<string> };

  constructor(readonly root: string, private readonly git: Git) {}

  async branches(): Promise<Branch[]> {
    const output = await this.git.text(this.root, [
      'for-each-ref', '--sort=refname', '--format=%(refname)%09%(symref)', 'refs/heads/', 'refs/remotes/',
    ]);
    return output.split('\n').flatMap(line => {
      const [ref, symbolic] = line.split('\t');
      // Remote HEAD aliases are not branches. Keep full refs to avoid ambiguous
      // names when a tag or local branch shadows a remote-tracking branch.
      return ref && !symbolic ? [{ name: ref.replace(/^refs\/(?:heads|remotes)\//, ''), ref }] : [];
    });
  }

  snapshot(reference: string, refresh = false): Promise<Snapshot> {
    // Automatic refreshes respect failure backoff. Manual refresh clears these
    // caches explicitly, while concurrent readers always share the running task.
    const running = this.pending.get(reference);
    if (running) return running;
    const failure = this.failures.get(reference);
    if (failure && failure.expires > Date.now()) return Promise.reject(failure.error);
    const cached = this.snapshots.get(reference);
    if (cached && !refresh) return Promise.resolve(cached);

    const promise = this.readSnapshot(reference).then(value => {
      this.failures.delete(reference);
      this.snapshots.set(reference, value);
      return value;
    }).catch(error => {
      this.snapshots.delete(reference);
      this.failures.set(reference, { error, expires: Date.now() + SNAPSHOT_RETRY_MS });
      throw error;
    }).finally(() => this.pending.delete(reference));
    this.pending.set(reference, promise);
    return promise;
  }

  private resolve(reference: string): Promise<string | undefined> {
    return this.git.optional(this.root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${reference}^{commit}`]);
  }

  private remoteDefaultBranch(remote: string): Promise<string> {
    if (this.remoteHeadCache?.remote === remote && this.remoteHeadCache.expires > Date.now()) {
      return this.remoteHeadCache.result;
    }
    const result = this.git.text(this.root, ['ls-remote', '--symref', '--', remote, 'HEAD']).then(output => {
      const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(output)?.[1];
      if (!branch) throw new Error('The remote did not advertise a default branch.');
      return branch;
    }).catch(error => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot detect ${remote}'s default branch. Check remote access and run Guttered: Refresh Comparison, ` +
        `or set Guttered: Base Reference to a locally available branch.\n${detail}`);
    });
    // Cache rejected lookups too: an offline remote must not be contacted on every poll.
    this.remoteHeadCache = { remote, result, expires: Date.now() + REMOTE_HEAD_CACHE_MS };
    return result;
  }

  private async defaultCandidates(): Promise<BaseCandidate[]> {
    const remotes = (await this.git.text(this.root, ['remote'])).split('\n').filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!remote) throw new Error('No remote default branch is available. Set Guttered: Base Reference in settings.');
    const prefix = `refs/remotes/${remote}/`;
    const symbolic = await this.git.optional(this.root, ['symbolic-ref', '--quiet', `${prefix}HEAD`]);
    const branch = symbolic?.startsWith(prefix) ? symbolic.slice(prefix.length) : await this.remoteDefaultBranch(remote);
    return [
      { ref: `${prefix}${branch}`, label: `${remote}/${branch}` },
      { ref: `refs/heads/${branch}`, label: branch },
    ];
  }

  private async readSnapshot(reference: string): Promise<Snapshot> {
    const [head, branch, candidates] = await Promise.all([
      this.resolve('HEAD'),
      this.git.optional(this.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      reference ? Promise.resolve([{ ref: reference, label: reference.replace(/^refs\/(?:heads|remotes)\//, '') }]) : this.defaultCandidates(),
    ]);
    if (!head) throw new Error('Comparison inactive: this repository has no HEAD commit yet.');
    let baseRef: string | undefined;
    let baseTip: string | undefined;
    for (const candidate of candidates) {
      baseTip = await this.resolve(candidate.ref);
      if (baseTip) {
        baseRef = candidate.label;
        break;
      }
    }
    if (!baseRef || !baseTip) {
      throw new Error(`Base reference is unavailable: ${candidates.map(candidate => candidate.label).join(' or ')}. Fetch it or choose another base reference.`);
    }
    const key = JSON.stringify([this.root, head, branch, baseRef, baseTip]);
    const previous = this.snapshots.get(reference);
    if (previous?.key === key) return previous;
    const mergeBase = await this.git.optional(this.root, ['merge-base', head, baseTip]);
    if (!mergeBase) throw new Error(`HEAD and ${baseRef} have no common ancestor. Check for shallow or unrelated history.`);
    return { root: this.root, head, branch: branch ?? `Detached HEAD (${head.slice(0, 8)})`, baseRef, baseTip, mergeBase, key };
  }

  isIgnored(file: string): Promise<boolean> {
    let result = this.ignored.get(file);
    if (!result) {
      // check-ignore respects the index, so a force-added file still gets markers.
      result = this.git.optional(this.root, ['check-ignore', '-q', '--', file]).then(output => output !== undefined);
      this.ignored.set(file, result);
    }
    return result;
  }

  clearIgnoreCache(): void { this.ignored.clear(); }

  clearTransientCaches(): void {
    this.snapshots.clear();
    this.failures.clear();
    this.ignored.clear();
    this.remoteHeadCache = undefined;
  }
}

export class GitService {
  private readonly directories = new Map<string, Promise<Repository | undefined>>();
  private readonly repositories = new Map<string, Repository>();
  private readonly baselines = new Map<string, Baseline>();
  private readonly pendingBaselines = new Map<string, Promise<Baseline>>();
  private cacheBytes = 0;
  constructor(readonly git = new Git()) {}

  async locate(file: string): Promise<{ repository: Repository; path: string } | undefined> {
    // Resolve directory symlinks, but keep the filename (which may itself be a tracked symlink).
    let directory = path.dirname(file);
    const suffix: string[] = [path.basename(file)];
    while (true) {
      try {
        await stat(directory);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(directory);
        if (parent === directory) return undefined;
        suffix.unshift(path.basename(directory));
        directory = parent;
      }
    }
    directory = await realpath(directory);
    let pending = this.directories.get(directory);
    if (!pending) {
      pending = this.discover(directory);
      this.directories.set(directory, pending);
      const forget = () => {
        if (this.directories.get(directory) === pending) this.directories.delete(directory);
      };
      void pending.then(value => { if (!value) forget(); }, forget);
    }
    const repository = await pending;
    if (!repository) return undefined;
    const relative = path.relative(repository.root, path.join(directory, ...suffix));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    // Worktrees and submodules use a .git pointer file instead of a directory.
    if (relative.toLowerCase() === '.git') return undefined;
    return { repository, path: relative.split(path.sep).join('/') };
  }

  private async discover(directory: string): Promise<Repository | undefined> {
    let root: string;
    try {
      root = await this.git.text(directory, ['rev-parse', '--show-toplevel']);
    } catch (error) {
      if (error instanceof GitError && /not a git repository|must be run in a work tree/i.test(error.message)) return undefined;
      throw error;
    }
    let repository = this.repositories.get(root);
    if (!repository) {
      repository = new Repository(root, this.git);
      this.repositories.set(root, repository);
    }
    return repository;
  }

  async baseline(snapshot: Pick<Snapshot, 'root' | 'mergeBase'>, file: string, maxBytes: number): Promise<Baseline> {
    const key = JSON.stringify([snapshot.root, snapshot.mergeBase, file]);
    let baseline = this.baselines.get(key);
    if (baseline) {
      this.baselines.delete(key);
      this.baselines.set(key, baseline);
    } else {
      // Reads with different size limits cannot share a promise that might reject
      // solely because one caller has a smaller limit. Successful blobs are shared.
      const pendingKey = `${key}:${maxBytes}`;
      let pending = this.pendingBaselines.get(pendingKey);
      if (!pending) {
        pending = this.readBaseline(snapshot, file, maxBytes).then(value => {
          if (!this.baselines.has(key)) {
            this.baselines.set(key, value);
            this.cacheBytes += value.bytes;
            while (this.cacheBytes > BASELINE_CACHE_BYTES || this.baselines.size > BASELINE_CACHE_ENTRIES) {
              const oldest = this.baselines.keys().next().value!;
              this.cacheBytes -= this.baselines.get(oldest)!.bytes;
              this.baselines.delete(oldest);
            }
          }
          return value;
        }).finally(() => this.pendingBaselines.delete(pendingKey));
        this.pendingBaselines.set(pendingKey, pending);
      }
      baseline = await pending;
    }
    if (baseline.bytes > maxBytes) throw new Error('Comparison paused: the baseline exceeds Guttered: Max File Size KB.');
    return baseline;
  }

  private async readBaseline(snapshot: Pick<Snapshot, 'root' | 'mergeBase'>, file: string, maxBytes: number): Promise<Baseline> {
    const entry = await this.git.text(snapshot.root, ['ls-tree', '-l', '-z', snapshot.mergeBase, '--', `:(literal)${file}`]);
    if (!entry) return { text: '', exists: false, bytes: 0 };
    const match = /^(\d+) (\w+) [a-f0-9]+\s+(\d+)\t/.exec(entry);
    if (!match || match[2] !== 'blob' || match[1] === '120000') throw new Error('Comparison inactive: the baseline is not a regular text file.');
    if (Number(match[3]) > maxBytes) throw new Error('Comparison paused: the baseline exceeds Guttered: Max File Size KB.');
    const buffer = await this.git.run(snapshot.root, ['show', `${snapshot.mergeBase}:${file}`], maxBytes + 4096);
    if (buffer.includes(0)) throw new Error('Comparison inactive: the baseline is a binary file.');
    let text: string;
    try {
      // Reject invalid bytes so Restore cannot write replacement characters into
      // files opened with another encoding. The decoder also removes a UTF-8 BOM.
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new Error('Comparison inactive: the baseline is not valid UTF-8 text.');
    }
    return { text, exists: true, bytes: buffer.length };
  }

  resetDiscovery(): void {
    this.directories.clear();
    for (const repository of this.repositories.values()) repository.clearIgnoreCache();
  }

  clearTransientCaches(): void {
    this.resetDiscovery();
    for (const repository of this.repositories.values()) repository.clearTransientCaches();
  }

  dispose(): void {
    this.git.dispose();
    this.directories.clear();
    this.repositories.clear();
    this.baselines.clear();
  }
}
