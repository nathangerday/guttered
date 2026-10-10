import type { FileChange, GitService, Repository, Snapshot } from './git';

export interface FileNode {
  path: string;
  status?: FileChange['status'];
  children: FileNode[];
}
export interface EditedFile { path: string; text: string; maxBytes: number }

/** Keep only the parent folders needed to reach changed files. */
export function fileTree(changes: readonly FileChange[]): FileNode[] {
  const root: FileNode = { path: '', children: [] };
  const folders = new Map([['', root]]);
  for (const file of changes) {
    const parts = file.path.split('/');
    let parent = root;
    for (let index = 1; index < parts.length; index++) {
      const folderPath = parts.slice(0, index).join('/');
      let folder = folders.get(folderPath);
      if (!folder) {
        folder = { path: folderPath, children: [] };
        folders.set(folderPath, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({ ...file, children: [] });
  }
  const sort = (nodes: FileNode[]) => {
    nodes.sort((a, b) => Number(!!a.status) - Number(!!b.status) || a.path.localeCompare(b.path));
    for (const node of nodes) sort(node.children);
  };
  sort(root.children);
  return root.children;
}

/** Editor buffers replace the disk result, including edits back to the baseline. */
export async function includeUnsaved(
  git: GitService, repository: Repository, snapshot: Snapshot,
  files: readonly FileChange[], documents: readonly EditedFile[],
): Promise<FileChange[]> {
  const changes = new Map(files.map(file => [file.path, file.status]));
  for (const document of documents) {
    try {
      if (Buffer.byteLength(document.text, 'utf8') > document.maxBytes) throw new Error('Document exceeds the text-comparison limit.');
      const baseline = await git.baseline(snapshot, document.path, document.maxBytes);
      if (!baseline.exists && await repository.isIgnored(document.path)) {
        changes.delete(document.path);
      } else if (baseline.exists && baseline.text.replace(/\r\n/g, '\n') === document.text.replace(/\r\n/g, '\n')) {
        changes.delete(document.path);
      } else {
        changes.set(document.path, baseline.exists ? 'M' : 'A');
      }
    } catch {
      // Large, binary, or non-UTF-8 files still belong in the file list. Their
      // editor decorations retain the existing text-comparison limits.
      if (!changes.has(document.path) && await repository.isIgnored(document.path)) continue;
      changes.set(document.path, changes.get(document.path) ?? 'M');
    }
  }
  return [...changes].map(([path, status]) => ({ path, status }));
}
