import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  UNGROUPED_NAME,
  GROUP_SCHEME,
  DND_MIME,
  viewed,
  getConfig,
  getRepoRoot,
  getLoadingViewed,
  getNestedMode,
  getUnviewedOnly,
  type GroupCfg,
  type TreeElement,
  type FileElement,
  type FolderElement,
  type GroupElement,
  type PlaceholderElement,
} from '../state';
import {
  groupsList,
  findGroup,
  buildFolderModel,
  nestedOrder,
  destGroupName,
  moveFiles,
  type FolderModel,
} from '../groups';

export class GroupTreeProvider
  implements vscode.TreeDataProvider<TreeElement>, vscode.TreeDragAndDropController<TreeElement>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _folderCache: Map<string, FolderModel> = new Map();

  readonly dropMimeTypes: readonly string[] = [DND_MIME];
  readonly dragMimeTypes: readonly string[] = [DND_MIME];

  refresh(): void {
    this._folderCache = new Map();
    this._onDidChangeTreeData.fire();
  }

  groupCounts(g: GroupCfg): { done: number; total: number } {
    const total = g.files.length;
    const done = g.files.filter(f => viewed.get(f)).length;
    return { done, total };
  }

  overallCounts(): { done: number; total: number; left: number } {
    let total = 0;
    let done = 0;
    for (const g of groupsList()) {
      total += g.files.length;
      done += g.files.filter(f => viewed.get(f)).length;
    }
    return { done, total, left: total - done };
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    const repoRoot = getRepoRoot();
    const loadingViewed = getLoadingViewed();
    const nestedMode = getNestedMode();
    if (element.kind === 'group') {
      const g = element.group;
      const { done, total } = this.groupCounts(g);
      const item = new vscode.TreeItem(g.name, vscode.TreeItemCollapsibleState.Collapsed);
      const countStr = loadingViewed ? `…/${total}` : `${done}/${total}`;
      item.description = countStr + (g.description ? ` · ${g.description}` : '');
      item.contextValue = g.name === UNGROUPED_NAME ? 'ungroupedGroup' : 'group';
      if (loadingViewed) {
        item.iconPath = new vscode.ThemeIcon('loading~spin');
      } else {
        const iconId = typeof g.icon === 'string' && g.icon ? g.icon : 'collection';
        item.iconPath = new vscode.ThemeIcon(iconId);
      }
      item.id = 'group:' + g.name;
      item.resourceUri = vscode.Uri.from({
        scheme: GROUP_SCHEME,
        path: '/' + encodeURIComponent(g.name),
      });
      item.tooltip = g.description || '';
      return item;
    }
    if (element.kind === 'folder') {
      let label: string | undefined = element.label;
      if (label == null) {
        const pn = this.folderModel(element.groupName).parentNode(element.prefix);
        label = pn ? element.prefix.slice(pn.length + 1) : element.prefix;
      }
      const item = new vscode.TreeItem(label!, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'folder';
      item.id = `folder:${element.groupName}:${element.prefix}`;
      item.resourceUri = vscode.Uri.file(path.join(repoRoot, element.prefix));
      return item;
    }
    if (element.kind === 'placeholder') {
      // Empty label + text in `description` renders muted (descriptionForeground).
      const item = new vscode.TreeItem('');
      item.description = element.label;
      item.tooltip =
        element.variant === 'empty'
          ? 'Drag files from another group onto this group to add them'
          : 'All files in this group are viewed';
      item.contextValue = 'placeholder';
      item.id = `placeholder:${element.groupName}`;
      return item;
    }
    // file
    const relPath = element.path;
    const item = new vscode.TreeItem(path.basename(relPath));
    item.description = nestedMode ? false : path.dirname(relPath);
    item.resourceUri = vscode.Uri.file(path.join(repoRoot, relPath));
    item.contextValue = 'file';
    item.id = `file:${element.groupName}:${relPath}`;
    item.checkboxState = viewed.get(relPath)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.command = {
      command: 'prReviewGroups.openDiff',
      title: 'Open diff',
      arguments: [relPath],
    };
    item.tooltip = relPath;
    return item;
  }

  visibleFiles(files: string[]): string[] {
    return getUnviewedOnly() ? files.filter(f => !viewed.get(f)) : files;
  }

  // Build a compacted folder model for a group's currently-visible files.
  folderModel(groupName: string): FolderModel {
    if (this._folderCache.has(groupName)) return this._folderCache.get(groupName)!;
    const g = findGroup(groupName);
    const model = buildFolderModel(g ? this.visibleFiles(g.files) : []);
    this._folderCache.set(groupName, model);
    return model;
  }

  // Immediate folder + file children of a node (group root when prefix === '').
  nestedChildren(groupName: string, prefix: string): TreeElement[] {
    const m = this.folderModel(groupName);
    const folders: FolderElement[] = [...m.dirs]
      .filter(d => m.isNode(d) && m.parentNode(d) === prefix)
      .sort()
      .map(d => ({
        kind: 'folder',
        groupName,
        prefix: d,
        label: prefix ? d.slice(prefix.length + 1) : d,
      }));
    const files: FileElement[] = (m.filesByDir.get(prefix) || [])
      .slice()
      .sort()
      .map(f => ({ kind: 'file', path: f, groupName }));
    return [...folders, ...files];
  }

  getChildren(element?: TreeElement): TreeElement[] {
    if (!getConfig()) return [];
    const nestedMode = getNestedMode();
    const unviewedOnly = getUnviewedOnly();
    if (!element) {
      return groupsList().map(g => ({ kind: 'group', group: g }) as GroupElement);
    }
    if (element.kind === 'group') {
      const g = element.group;
      if (!g.files.length) {
        return [
          {
            kind: 'placeholder',
            variant: 'empty',
            groupName: g.name,
            label: 'No files — drag files here',
          } as PlaceholderElement,
        ];
      }
      const kids: TreeElement[] = nestedMode
        ? this.nestedChildren(g.name, '')
        : this.visibleFiles(g.files).map(
            f => ({ kind: 'file', path: f, groupName: g.name }) as FileElement,
          );
      if (!kids.length && unviewedOnly) {
        return [
          {
            kind: 'placeholder',
            variant: 'allViewed',
            groupName: g.name,
            label: 'All viewed',
          } as PlaceholderElement,
        ];
      }
      return kids;
    }
    if (element.kind === 'folder') {
      return this.nestedChildren(element.groupName, element.prefix);
    }
    return [];
  }

  getParent(element: TreeElement): TreeElement | null {
    if (!getConfig() || !element) return null;
    const nestedMode = getNestedMode();
    const groupEl = (name: string): GroupElement | null => {
      const g = findGroup(name);
      return g ? { kind: 'group', group: g } : null;
    };
    if (element.kind === 'folder') {
      const p = this.folderModel(element.groupName).parentNode(element.prefix);
      return p === ''
        ? groupEl(element.groupName)
        : ({ kind: 'folder', groupName: element.groupName, prefix: p } as FolderElement);
    }
    if (element.kind === 'file') {
      if (nestedMode) {
        const dir = element.path.includes('/')
          ? element.path.slice(0, element.path.lastIndexOf('/'))
          : '';
        if (dir !== '') {
          return { kind: 'folder', groupName: element.groupName, prefix: dir } as FolderElement;
        }
      }
      return groupEl(element.groupName);
    }
    if (element.kind === 'placeholder') return groupEl(element.groupName);
    return null;
  }

  // The next file element after (path, groupName) in display order, honoring the
  // unviewed-only filter.
  nextFile(filePath: string, groupName: string): FileElement | null {
    const nestedMode = getNestedMode();
    const unviewedOnly = getUnviewedOnly();
    const groups = groupsList();
    const flat: FileElement[] = [];
    for (const g of groups) {
      const ordered = nestedMode ? nestedOrder(g.files) : g.files;
      for (const f of ordered) flat.push({ kind: 'file', path: f, groupName: g.name });
    }
    let idx = flat.findIndex(x => x.path === filePath && x.groupName === groupName);
    if (idx === -1) idx = flat.findIndex(x => x.path === filePath);
    for (let i = idx + 1; i < flat.length; i++) {
      if (!unviewedOnly || !viewed.get(flat[i].path)) return flat[i];
    }
    return null;
  }

  // ---------- drag and drop ----------

  handleDrag(source: readonly TreeElement[], dataTransfer: vscode.DataTransfer): void {
    const files = source
      .filter((e): e is FileElement => e.kind === 'file')
      .map(e => ({ path: e.path, groupName: e.groupName }));
    if (files.length) {
      dataTransfer.set(DND_MIME, new vscode.DataTransferItem(JSON.stringify(files)));
    }
  }

  async handleDrop(
    target: TreeElement | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    const item = dataTransfer.get(DND_MIME);
    if (!item) return;
    let files: Array<{ path: string; groupName: string }>;
    try {
      files = JSON.parse(await item.asString());
    } catch {
      return;
    }
    const dest = destGroupName(target);
    if (dest && Array.isArray(files) && files.length) moveFiles(files, dest);
  }
}

