import * as vscode from 'vscode';
import {
  UNGROUPED_NAME,
  getConfig,
  getProvider,
  getHeaderProvider,
  getGroupDecoration,
  getUngroupedFiles,
  type GroupCfg,
} from '../state';
import { ALL_ICONS } from '../icons';
import { writeConfig } from '../config';

// config.groups plus a synthetic "Ungrouped" group for files new in the PR.
export function groupsList(): GroupCfg[] {
  const config = getConfig();
  if (!config) return [];
  const ungroupedFiles = getUngroupedFiles();
  if (ungroupedFiles.length) {
    return config.groups.concat([{ name: UNGROUPED_NAME, description: '', files: ungroupedFiles }]);
  }
  return config.groups;
}

export function findGroup(name: string): GroupCfg | null {
  return groupsList().find(g => g.name === name) || null;
}

export function refreshAll(): void {
  const provider = getProvider();
  if (provider) provider.refresh();
  const headerProvider = getHeaderProvider();
  if (headerProvider) headerProvider.post();
  const groupDecoration = getGroupDecoration();
  if (groupDecoration) groupDecoration.refresh();
}

// Move files into a real config group. Files leave their current group (or the
// synthetic Ungrouped bucket); viewed state is unaffected. Writes config + refreshes.
export function moveFiles(
  files: Array<{ path: string; groupName: string }>,
  destName: string,
): void {
  const config = getConfig();
  if (!config) return;
  if (destName === UNGROUPED_NAME) {
    markUngrouped(files);
    return;
  }
  const dest = config.groups.find(g => g.name === destName);
  if (!dest) return;
  const ungroupedFiles = getUngroupedFiles();
  let moved = 0;
  for (const { path: relPath, groupName } of files) {
    if (groupName === destName) continue;
    if (groupName === UNGROUPED_NAME) {
      const i = ungroupedFiles.indexOf(relPath);
      if (i !== -1) ungroupedFiles.splice(i, 1);
    } else {
      const src = config.groups.find(g => g.name === groupName);
      if (src) {
        const i = src.files.indexOf(relPath);
        if (i !== -1) src.files.splice(i, 1);
      }
    }
    if (!dest.files.includes(relPath)) dest.files.push(relPath);
    moved++;
  }
  if (!moved) return;
  dest.files.sort();
  writeConfig();
  refreshAll();
  vscode.window.setStatusBarMessage(
    `PR Review Groups: moved ${moved} file${moved === 1 ? '' : 's'} to "${destName}"`,
    3000,
  );
}

// Move files out of their group and into the synthetic "Ungrouped" bucket. They're
// dropped from config.groups on disk; on reload they recompute as ungrouped naturally.
export function markUngrouped(files: Array<{ path: string; groupName: string }>): void {
  const config = getConfig();
  if (!config) return;
  const ungroupedFiles = getUngroupedFiles();
  let moved = 0;
  for (const { path: relPath, groupName } of files) {
    if (groupName === UNGROUPED_NAME) continue;
    const src = config.groups.find(g => g.name === groupName);
    if (src) {
      const i = src.files.indexOf(relPath);
      if (i !== -1) src.files.splice(i, 1);
    }
    if (!ungroupedFiles.includes(relPath)) ungroupedFiles.push(relPath);
    moved++;
  }
  if (!moved) return;
  ungroupedFiles.sort();
  writeConfig();
  refreshAll();
  vscode.window.setStatusBarMessage(
    `PR Review Groups: moved ${moved} file${moved === 1 ? '' : 's'} to "${UNGROUPED_NAME}"`,
    3000,
  );
}

// Set/clear a real group's icon (codicon id). Empty -> falls back to the folder icon.
export async function setGroupIcon(groupName: string): Promise<void> {
  const config = getConfig();
  if (!config || groupName === UNGROUPED_NAME) return;
  const g = config.groups.find(x => x.name === groupName);
  if (!g) return;
  interface IconPick extends vscode.QuickPickItem {
    _clear?: boolean;
    _icon?: string;
  }
  const CLEAR: IconPick = { label: '$(collection) Clear icon — use default', _clear: true };
  const SEP: vscode.QuickPickItem = { label: 'Icons', kind: vscode.QuickPickItemKind.Separator };
  const items: IconPick[] = [
    CLEAR,
    SEP as IconPick,
    ...ALL_ICONS.map(id => ({ label: `$(${id}) ${id}`, _icon: id }) as IconPick),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: g.icon
      ? `Current: ${g.icon} — choose a new icon`
      : 'Choose an icon for this group',
  });
  if (!pick) return;
  const next = pick._clear ? '' : pick._icon || '';
  if (next) g.icon = next;
  else delete g.icon;
  writeConfig();
  refreshAll();
}

// Set/clear a real group's description (shown next to the count).
export async function setGroupDescription(groupName: string): Promise<void> {
  const config = getConfig();
  if (!config || groupName === UNGROUPED_NAME) return;
  const g = config.groups.find(x => x.name === groupName);
  if (!g) return;
  const desc = await vscode.window.showInputBox({
    prompt: 'Group description — shown next to the file count. Leave empty to clear.',
    value: g.description || '',
  });
  if (desc === undefined) return;
  const t = desc.trim();
  if (t) g.description = t;
  else delete g.description;
  writeConfig();
  refreshAll();
}

// Rename a real config group (Ungrouped is synthetic and can't be renamed).
export async function renameGroup(groupName: string): Promise<void> {
  const config = getConfig();
  if (!config || groupName === UNGROUPED_NAME) return;
  const g = config.groups.find(x => x.name === groupName);
  if (!g) return;
  const name = await vscode.window.showInputBox({
    prompt: 'Rename group',
    value: g.name,
    validateInput: v => {
      const t = (v || '').trim();
      if (!t) return 'Name required';
      if (t !== g.name && (t === UNGROUPED_NAME || config.groups.some(x => x.name === t))) {
        return 'A group with that name already exists';
      }
      return null;
    },
  });
  if (!name || name.trim() === g.name) return;
  g.name = name.trim();
  writeConfig();
  refreshAll();
}

// Delete a real config group; its files fall back to "Ungrouped".
export async function deleteGroup(groupName: string): Promise<void> {
  const config = getConfig();
  if (!config || groupName === UNGROUPED_NAME) return;
  const idx = config.groups.findIndex(x => x.name === groupName);
  if (idx === -1) return;
  const g = config.groups[idx];
  const n = g.files.length;
  const pick = await vscode.window.showWarningMessage(
    `Delete group "${g.name}"?`,
    {
      modal: true,
      detail: n ? `Its ${n} file${n === 1 ? '' : 's'} will move to "${UNGROUPED_NAME}".` : '',
    },
    'Delete',
  );
  if (pick !== 'Delete') return;
  const ungroupedFiles = getUngroupedFiles();
  for (const f of g.files) if (!ungroupedFiles.includes(f)) ungroupedFiles.push(f);
  ungroupedFiles.sort();
  config.groups.splice(idx, 1);
  writeConfig();
  refreshAll();
}

// Prompt for a new group name, append an empty group, persist. Returns the name.
export async function promptNewGroup(): Promise<string | null> {
  const config = getConfig();
  if (!config) return null;
  const name = await vscode.window.showInputBox({
    prompt: 'New group name',
    validateInput: v => {
      const t = (v || '').trim();
      if (!t) return 'Name required';
      if (t === UNGROUPED_NAME || config.groups.some(g => g.name === t)) {
        return 'A group with that name already exists';
      }
      return null;
    },
  });
  if (!name) return null;
  config.groups.push({ name: name.trim(), description: '', files: [] });
  writeConfig();
  refreshAll();
  return name.trim();
}
