import * as vscode from 'vscode';
import {
  getConfig,
  getBranchPR,
  getDiffStat,
  getLoadingViewed,
  getProvider,
  getTreeView,
  getHeaderProvider,
  getGroupDecoration,
} from '../../state';
import { jiraKeyOf, usesGitHub } from '../../config';
import type { GroupTreeProvider } from '../tree';
import headerHtml from './header.html';

export class HeaderViewProvider implements vscode.WebviewViewProvider {
  view: vscode.WebviewView | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === 'openPR') vscode.commands.executeCommand('prReviewGroups.openOnGitHub');
      else if (msg.type === 'openJira') vscode.commands.executeCommand('prReviewGroups.openJira');
      else if (msg.type === 'setup') vscode.commands.executeCommand('prReviewGroups.setupFromPR');
      else if (msg.type === 'signin')
        vscode.commands.executeCommand('prReviewGroups.signInAndDetect');
      else if (msg.type === 'createGroup')
        vscode.commands.executeCommand('prReviewGroups.createFirstGroup');
      else if (msg.type === 'reload') vscode.commands.executeCommand('prReviewGroups.reload');
      else if (msg.type === 'ready') this.post();
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.post();
    });
  }

  post(): void {
    if (!this.view) return;
    const config = getConfig();
    // "Setup" while no config is loaded (welcome), "Overview" once it is.
    this.view.title = config ? 'Overview' : 'Setup';
    const pr = (config && config.pr) || {};
    const provider = getProvider() as GroupTreeProvider | null;
    const { done, total } = provider ? provider.overallCounts() : { done: 0, total: 0 };
    const diffStat = getDiffStat();
    this.view.webview.postMessage({
      type: 'state',
      hasConfig: !!config,
      detect: getBranchPR() || { state: 'idle' },
      jiraKey: pr.jira ? jiraKeyOf(pr.jira) : '',
      title: pr.title || (pr.url ? 'Pull request' : 'Local review'),
      number: pr.number || null,
      hasSlack: !!pr.slack,
      done,
      total,
      loading: getLoadingViewed(),
      additions: diffStat ? diffStat.additions : 0,
      deletions: diffStat ? diffStat.deletions : 0,
    });
  }

  html(): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return headerHtml.replaceAll('__NONCE__', nonce);
  }
}

// Drive the view's title-bar (outside the scrollable tree) from PR metadata + live
// overall progress, so the PR title never shifts as the file list changes.
export function updateViewMeta(): void {
  const treeView = getTreeView();
  if (treeView) {
    treeView.description = undefined;
    const config = getConfig();
    const noGroups = !!config && config.groups.length === 0;
    const unlinked = !!config && !usesGitHub();
    treeView.message = noGroups
      ? 'No groups yet — use the New group (+) button above to create one.'
      : unlinked
        ? "Local-only review. Click the link icon above to attach this branch's PR and sync viewed state to GitHub."
        : undefined;
  }
  const headerProvider = getHeaderProvider();
  if (headerProvider) headerProvider.post();
  const groupDecoration = getGroupDecoration();
  if (groupDecoration) groupDecoration.refresh();
}
