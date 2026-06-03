import * as vscode from 'vscode';
import {
  BASE_SCHEME,
  setExtContext,
  setOutput,
  setProvider,
  setTreeView,
  setHeaderProvider,
  setGroupDecoration,
  setUnviewedOnly,
  setNestedMode,
  setBranchPR,
  setLoadingViewed,
  setDiffStat,
  setUngroupedFiles,
  getConfig,
  getTreeView,
  getHeaderProvider,
  getProvider,
  viewed,
} from './state';
import { loadConfig, ensureGitExclude, usesGitHub } from './config';
import { computeDiffStat, listChangedFiles, gitShow } from './remote/git';
import { detectBranchPR, fetchViewedState } from './remote/github';
import { GroupTreeProvider } from './ui/tree';
import { GroupDecorationProvider } from './ui/decoration';
import { HeaderViewProvider, updateViewMeta } from './ui/webview';
import { onCheckboxChanged, loadLocalViewed } from './remote/viewed';
import { registerCommands, setReload as setCommandsReload } from './commands';
import { setReload as setGroupsReload } from './groups';
import { getSuppressWatch } from './state';

async function reload(): Promise<void> {
  const ok = loadConfig();
  const config = getConfig();
  await vscode.commands.executeCommand('setContext', 'prReviewGroups.hasConfig', ok);
  await vscode.commands.executeCommand(
    'setContext',
    'prReviewGroups.hasSlack',
    !!(ok && config && config.pr && config.pr.slack),
  );
  await vscode.commands.executeCommand(
    'setContext',
    'prReviewGroups.hasJira',
    !!(ok && config && config.pr && config.pr.jira),
  );
  await vscode.commands.executeCommand(
    'setContext',
    'prReviewGroups.hasPrUrl',
    !!(ok && config && config.pr && config.pr.url),
  );
  await vscode.commands.executeCommand(
    'setContext',
    'prReviewGroups.unlinked',
    ok && !usesGitHub(),
  );
  const provider = getProvider() as GroupTreeProvider | null;
  const treeView = getTreeView();
  const headerProvider = getHeaderProvider();
  if (ok && config) {
    ensureGitExclude();
    setDiffStat(await computeDiffStat());
    const changed = await listChangedFiles();
    const inGroups = new Set(config.groups.flatMap(g => g.files));
    const ungrouped = changed.filter(f => !inGroups.has(f)).sort();
    setUngroupedFiles(ungrouped);
    for (const f of ungrouped) if (!viewed.has(f)) viewed.set(f, false);
    if (usesGitHub()) {
      setLoadingViewed(true);
      if (provider) provider.refresh();
      if (treeView) treeView.description = 'Loading viewed state…';
      if (headerProvider) headerProvider.post();
      await vscode.window.withProgress(
        { location: { viewId: 'prReviewGroups.tree' }, title: 'Loading viewed state…' },
        () => fetchViewedState(),
      );
      setLoadingViewed(false);
    } else {
      loadLocalViewed();
      if (provider) provider.refresh();
    }
  } else {
    setBranchPR({ state: 'loading' });
    if (headerProvider) headerProvider.post();
    setBranchPR(await detectBranchPR());
  }
  if (provider) provider.refresh();
  updateViewMeta();
  if (ok && config) {
    const total = config.groups.reduce((a, g) => a + g.files.length, 0);
    vscode.window.setStatusBarMessage(
      `PR Review Groups: ${config.groups.length} groups, ${total} files loaded`,
      4000,
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('PR Review Groups');
  setOutput(output);
  const provider = new GroupTreeProvider();
  setProvider(provider);

  setExtContext(context);
  const unviewedOnly = context.workspaceState.get('prReviewGroups.unviewedOnly', false);
  const nestedMode = context.workspaceState.get('prReviewGroups.nested', false);
  setUnviewedOnly(unviewedOnly);
  setNestedMode(nestedMode);
  vscode.commands.executeCommand('setContext', 'prReviewGroups.unviewedOnly', unviewedOnly);
  vscode.commands.executeCommand('setContext', 'prReviewGroups.nested', nestedMode);

  // git-show content provider for the base side of diffs
  const baseProvider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: async (uri: vscode.Uri): Promise<string> => {
      const relPath = uri.path.replace(/^\//, '');
      const ref = uri.query || 'master';
      return await gitShow(ref, relPath);
    },
  };

  const treeView = vscode.window.createTreeView('prReviewGroups.tree', {
    treeDataProvider: provider,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
    canSelectMany: true,
    dragAndDropController: provider,
  });
  setTreeView(treeView);

  const headerProvider = new HeaderViewProvider();
  setHeaderProvider(headerProvider);
  const groupDecoration = new GroupDecorationProvider();
  setGroupDecoration(groupDecoration);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('prReviewGroups.header', headerProvider),
    vscode.window.registerFileDecorationProvider(groupDecoration),
  );

  context.subscriptions.push(
    output,
    treeView,
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseProvider),
    treeView.onDidChangeCheckboxState(onCheckboxChanged),
  );

  // Wire reload back into modules that needed a forward declaration.
  setCommandsReload(reload);
  setGroupsReload(reload);

  registerCommands(context);

  // recompute when config file changes on disk
  const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/review-groups.json');
  const onConfigFileChanged = (): void => {
    if (getSuppressWatch()) return;
    reload();
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onConfigFileChanged),
    watcher.onDidCreate(onConfigFileChanged),
  );

  reload();
}

export function deactivate(): void {
  /* no-op */
}
