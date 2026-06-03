import * as vscode from 'vscode';
import {
  viewed,
  getExtContext,
  getProvider,
  getTreeView,
  getPrNodeId,
  getHeaderProvider,
  getGroupDecoration,
  log,
  type FileElement,
} from '../state';
import { setViewedOnGitHub } from './github';
import { openDiff } from '../ui/diff';
import { workspaceRoot } from './git';

// Local (workspace-scoped) viewed state, used when the config has no PR node id
// (e.g. a hand-made config) so checkboxes still toggle without GitHub.
export function localViewedKey(): string {
  return 'prReviewGroups.localViewed:' + workspaceRoot();
}

export function loadLocalViewed(): void {
  const ctx = getExtContext();
  if (!ctx) return;
  const stored = ctx.workspaceState.get<Record<string, boolean>>(localViewedKey(), {});
  for (const k of Object.keys(stored)) if (viewed.has(k)) viewed.set(k, !!stored[k]);
}

export function saveLocalViewed(): void {
  const ctx = getExtContext();
  if (!ctx) return;
  const obj: Record<string, boolean> = {};
  for (const [k, v] of viewed) if (v) obj[k] = true;
  ctx.workspaceState.update(localViewedKey(), obj);
}

function updateViewMetaLocal(): void {
  // Avoid importing webview.ts here (circular). The header/decoration refresh suffices
  // for the checkbox path — extension.ts wires the broader updateViewMeta elsewhere.
  const headerProvider = getHeaderProvider();
  if (headerProvider) headerProvider.post();
  const groupDecoration = getGroupDecoration();
  if (groupDecoration) groupDecoration.refresh();
}

async function advanceToNext(path: string, groupName: string): Promise<void> {
  const provider = getProvider();
  const treeView = getTreeView();
  if (!provider) return;
  const next = provider.nextFile(path, groupName);
  if (!next) return;
  try {
    if (treeView) await treeView.reveal(next, { select: true, focus: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`reveal failed: ${msg}`);
  }
  openDiff(next.path);
}

export function onCheckboxChanged(e: vscode.TreeCheckboxChangeEvent<FileElement | unknown>): void {
  const provider = getProvider();
  const changes: Array<{ relPath: string; want: boolean; prev: boolean; groupName: string }> = [];
  for (const [element, state] of e.items) {
    const el = element as { kind?: string; path?: string; groupName?: string };
    if (el.kind !== 'file' || !el.path || !el.groupName) continue;
    const relPath = el.path;
    const want = state === vscode.TreeItemCheckboxState.Checked;
    const prev = viewed.get(relPath) || false;
    if (want === prev) continue;
    viewed.set(relPath, want); // optimistic
    changes.push({ relPath, want, prev, groupName: el.groupName });
  }
  if (!changes.length) return;
  if (provider) provider.refresh();
  updateViewMetaLocal();

  // After marking a file viewed, advance selection to the next file.
  const lastViewed = [...changes].reverse().find(c => c.want);
  if (lastViewed) advanceToNext(lastViewed.relPath, lastViewed.groupName);

  // No PR node id (hand-made config): persist viewed state locally instead of GitHub.
  if (!getPrNodeId()) {
    saveLocalViewed();
    return;
  }

  // Sync to GitHub in the background; revert the file (and re-render) only on failure.
  for (const { relPath, want, prev } of changes) {
    setViewedOnGitHub(relPath, want)
      .then(() => log(`${want ? 'marked' : 'unmarked'} viewed: ${relPath}`))
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        viewed.set(relPath, prev); // revert
        if (provider) provider.refresh();
        updateViewMetaLocal();
        vscode.window.showErrorMessage(
          `PR Review Groups: GitHub update failed for ${relPath}: ${msg}`,
        );
      });
  }
}
