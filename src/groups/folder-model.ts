import { type TreeElement } from '../state';

// Compacted folder model for a set of file paths: which dirs are real tree nodes
// (have files or branch) and each node's parent node.
export interface FolderModel {
  dirs: Set<string>;
  filesByDir: Map<string, string[]>;
  isNode: (d: string) => boolean;
  parentNode: (d: string) => string;
}

export function buildFolderModel(files: string[]): FolderModel {
  const filesByDir = new Map<string, string[]>();
  const dirs = new Set<string>();
  const childDirs = new Map<string, Set<string>>();
  const dirOf = (f: string): string => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
  const parentOf = (d: string): string => (d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '');
  for (const f of files) {
    const d = dirOf(f);
    if (!filesByDir.has(d)) filesByDir.set(d, []);
    filesByDir.get(d)!.push(f);
    const parts = d === '' ? [] : d.split('/');
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of dirs) {
    const p = parentOf(d);
    if (!childDirs.has(p)) childDirs.set(p, new Set());
    childDirs.get(p)!.add(d);
  }
  const isNode = (d: string): boolean =>
    (filesByDir.get(d)?.length ?? 0) > 0 || (childDirs.get(d)?.size || 0) >= 2;
  const parentNode = (d: string): string => {
    let p = parentOf(d);
    while (p !== '' && !isNode(p)) p = parentOf(p);
    return p;
  };
  return { dirs, filesByDir, isNode, parentNode };
}

// Files in nested-tree display order (folders-first then files, sorted at each level),
// matching exactly what the tree renders. Used so auto-advance follows visual order.
export function nestedOrder(files: string[]): string[] {
  const m = buildFolderModel(files);
  const out: string[] = [];
  const walk = (prefix: string): void => {
    const folders = [...m.dirs].filter(d => m.isNode(d) && m.parentNode(d) === prefix).sort();
    for (const d of folders) walk(d);
    for (const f of (m.filesByDir.get(prefix) || []).slice().sort()) out.push(f);
  };
  walk('');
  return out;
}

// The destination group name implied by a drop target (group header, a folder in a
// group, or a file in a group). Null when the target can't host files.
export function destGroupName(element: TreeElement | undefined): string | null {
  if (!element) return null;
  if (element.kind === 'group') return element.group.name;
  if (element.kind === 'folder' || element.kind === 'file' || element.kind === 'placeholder') {
    return element.groupName;
  }
  return null;
}
