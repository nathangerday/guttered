import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';

const begin = '\n/* GUTTERED WORKBENCH INJECTION v1 BEGIN */\n';
const end = '\n/* GUTTERED WORKBENCH INJECTION v1 END */\n';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const exists = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
interface Record { original: string; suffix: string; previousSuffix?: string }

// Discover service identifiers from their stable string IDs, never hard-code
// minified names. Fail before writing if the desktop module format changes.
export function injectionSuffix(source: string, bundle: string): string {
  if (!/export\{[\w$]+ as main\}/.test(source)) throw new Error('This desktop workbench format is unsupported. No files were changed.');
  const service = (id: string) => {
    const matches = [...source.matchAll(new RegExp(`([\\w$]+)=([\\w$]+)\\("${id}"\\)`, 'g'))];
    if (matches.length !== 1) throw new Error(`Cannot locate ${id}. No files were changed.`);
    return matches[0]![1]!;
  };
  const registries = [...source.matchAll(/([\w$]+)=new class\{constructor\(\)\{[^{}]{0,300}\}registerCommand\(/g)];
  if (registries.length !== 1) throw new Error('Cannot locate the workbench command registry. No files were changed.');
  const code = service('codeEditorService');
  const commands = service('commandService');
  const configuration = service('configurationService');
  const revision = hash(bundle);
  return begin + `(()=>{
${bundle}
${registries[0]![1]}.registerCommand({id:"guttered._workbenchConnect",handler:(accessor,enabled,revision,session)=>{const active=enabled===true&&revision==="${revision}"&&typeof session==="string"&&session.length>0&&session.length<=128;GutteredWorkbench.connect(accessor.get(${code}),accessor.get(${commands}),accessor.get(${configuration}),active,session);return {protocol:2,revision:"${revision}",active};}});
${registries[0]![1]}.registerCommand({id:"guttered._workbenchDisconnect",handler:(_accessor,session)=>GutteredWorkbench.disconnect(session)});
})();` + end;
}

async function optional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); } catch (error) { if (exists(error)) return; throw error; }
}
async function atomic(file: string, text: string, mode: number): Promise<void> {
  const temporary = `${file}.guttered-${randomUUID()}`;
  try {
    await writeFile(temporary, text, { mode, flag: 'wx' });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

export class WorkbenchPatch {
  readonly backup: string;
  private readonly state: string;
  constructor(readonly file: string) {
    this.backup = `${file}.guttered-original`;
    this.state = `${file}.guttered-state.json`;
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const lock = `${this.file}.guttered-lock`;
    let acquired = false;
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      acquired = true;
      return await action();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new Error('The VS Code installation is not writable. Install a user-owned desktop copy to use gutter clicks.');
      }
      if (code === 'EEXIST' && !acquired) throw new Error(`Another patch operation is in progress. If no operation is running, remove ${lock} and retry.`);
      throw error;
    } finally { if (acquired) await unlink(lock); }
  }
  private async record(): Promise<Record | undefined> {
    const text = await optional(this.state);
    if (!text) return;
    let value: Record;
    try { value = JSON.parse(text) as Record; }
    catch { throw new Error(`Invalid Guttered restoration metadata. Backup: ${this.backup}`); }
    if (!value || typeof value.original !== 'string' || typeof value.suffix !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.original) || !/^[a-f0-9]{64}$/.test(value.suffix)
      || (value.previousSuffix !== undefined && (typeof value.previousSuffix !== 'string' || !/^[a-f0-9]{64}$/.test(value.previousSuffix)))) {
      throw new Error(`Invalid Guttered restoration metadata. Backup: ${this.backup}`);
    }
    const original = await optional(this.backup);
    if (original === undefined || hash(original) !== value.original) throw new Error(`Guttered's backup failed verification: ${this.backup}`);
    return value;
  }
  private suffix(source: string, record: Record | undefined): number {
    const start = source.indexOf(begin);
    if (start < 0) return -1;
    if (!record || !source.endsWith(end) || ![record.suffix, record.previousSuffix].includes(hash(source.slice(start)))) {
      throw new Error(`The injected workbench code changed. Restore it manually from ${this.backup}; no files were changed.`);
    }
    return start;
  }
  async apply(bundle: string): Promise<boolean> {
    return this.locked(async () => {
      const source = await readFile(this.file, 'utf8');
      const record = source.includes(begin) ? await this.record() : undefined;
      const start = this.suffix(source, record);
      const original = start < 0 ? source : source.slice(0, start);
      const suffix = injectionSuffix(original, bundle);
      if (start >= 0 && source.slice(start) === suffix) return false;
      const mode = (await stat(this.file)).mode;
      // Write the recovery artifacts before touching the installation. A new
      // desktop update without our suffix becomes the new baseline only here,
      // in an explicitly requested apply operation.
      if (start < 0) await atomic(this.backup, original, mode);
      // Accept both suffixes while atomically replacing the module, so a crash
      // between metadata and module writes still permits restoration/retry.
      await atomic(this.state, JSON.stringify({ original: record?.original ?? hash(original), suffix: hash(suffix),
        ...(start >= 0 ? { previousSuffix: hash(source.slice(start)) } : {}), }), 0o600);
      await atomic(this.file, original + suffix, mode);
      return true;
    });
  }
  async restore(): Promise<boolean> {
    return this.locked(async () => {
      const source = await readFile(this.file, 'utf8');
      const record = source.includes(begin) ? await this.record() : undefined;
      const start = this.suffix(source, record);
      if (start >= 0) await atomic(this.file, source.slice(0, start), (await stat(this.file)).mode);
      // Never overwrite a newer installation with an old backup. Removing only
      // our verified suffix also preserves another tool's changes to the file.
      await unlink(this.state).catch(error => { if (!exists(error)) throw error; });
      await unlink(this.backup).catch(error => { if (!exists(error)) throw error; });
      return start >= 0;
    });
  }
}
