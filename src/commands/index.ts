import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  UNGROUPED_NAME,
  getConfig,
  setUnviewedOnly,
  setNestedMode,
  getRepoRoot,
  getProvider,
  getTreeView,
  persist,
  type FileElement,
  type TreeElement,
} from '../state';
import { configPath, jiraBaseUrl, joinJira, saveJiraBase, splitJira, jiraKeyOf } from '../config';
import { writeConfig } from '../config';
import {
  promptNewGroup,
  startManual,
  setupFromPR,
  linkPR,
  setGroupIcon,
  setGroupDescription,
  renameGroup,
  deleteGroup,
  moveFiles,
  markUngrouped,
  slackDeepLink,
} from '../groups';
import { openDiff } from '../ui/diff';
import { getToken } from '../remote/github';

const trimSlash = (s: string | undefined): string => String(s || '').replace(/\/+$/, '');

// Set, change, or remove the Slack thread URL on the loaded config.
async function setSlack(): Promise<void> {
  const config = getConfig();
  if (!config) return;
  const cur = (config.pr && config.pr.slack) || '';
  const url = await vscode.window.showInputBox({
    prompt: 'Slack thread URL for this PR (leave empty to remove)',
    placeHolder: 'https://<workspace>.slack.com/archives/CXXXXXX/p1700000000000000',
    value: cur,
    validateInput: v => {
      const t = (v || '').trim();
      if (!t) return null;
      if (!/^https?:\/\//.test(t) && !t.startsWith('slack://'))
        return 'Enter a Slack URL (https://… or slack://…)';
      return null;
    },
  });
  if (url === undefined) return;
  if (!config.pr) config.pr = {};
  const t = url.trim();
  if (t) config.pr.slack = t;
  else delete config.pr.slack;
  writeConfig();
  await reloadFn?.();
}

// Set, change, or remove the JIRA ticket on the loaded config.
async function setJira(): Promise<void> {
  const config = getConfig();
  if (!config) return;
  const cur = (config.pr && config.pr.jira) || '';
  const base = jiraBaseUrl();
  const val = await vscode.window.showInputBox({
    prompt: base
      ? 'JIRA ticket key (e.g. PROJ-123) or full URL — empty to remove'
      : 'JIRA ticket URL — empty to remove',
    placeHolder: base ? 'PROJ-123' : 'https://<your-org>.atlassian.net/browse/PROJ-123',
    value: cur,
  });
  if (val === undefined) return;
  if (!config.pr) config.pr = {};
  const t = val.trim();
  if (!t) {
    delete config.pr.jira;
    writeConfig();
    await reloadFn?.();
    return;
  }
  let url: string;
  if (/^https?:\/\//.test(t)) {
    url = t;
    const parts = splitJira(t);
    if (parts && parts.base) {
      const saved = jiraBaseUrl();
      if (!saved) {
        await saveJiraBase(parts.base);
      } else if (trimSlash(saved) !== trimSlash(parts.base)) {
        const pick = await vscode.window.showInformationMessage(
          `This ticket uses a different JIRA base:\n${parts.base}\nUpdate your saved base?`,
          'Update',
          'Keep current',
        );
        if (pick === 'Update') await saveJiraBase(parts.base);
      }
    }
  } else {
    const b = jiraBaseUrl();
    if (!b) {
      vscode.window.showWarningMessage(
        'PR Review Groups: enter the full JIRA ticket URL the first time — the base is saved so next time a key like PROJ-123 is enough.',
      );
      return;
    }
    url = joinJira(b, t);
  }
  config.pr.jira = url;
  writeConfig();
  await reloadFn?.();
}

// Gear menu in the Overview title bar: manage the PR's Slack thread and JIRA ticket.
async function openSettings(): Promise<void> {
  const config = getConfig();
  if (!config) return;
  const slack = (config.pr && config.pr.slack) || '';
  const jira = (config.pr && config.pr.jira) || '';
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: '$(comment-discussion) Slack thread',
        description: slack || 'not set',
        _act: 'slack',
      },
      {
        label: '$(milestone) JIRA ticket',
        description: jira ? jiraKeyOf(jira) : 'not set',
        _act: 'jira',
      },
    ],
    { placeHolder: 'Manage PR links' },
  );
  if (!pick) return;
  if (pick._act === 'slack') return setSlack();
  if (pick._act === 'jira') return setJira();
}

// Forward-declared reload (wired from extension.ts to avoid a circular import).
let reloadFn: (() => Promise<void>) | null = null;
export function setReload(fn: () => Promise<void>): void {
  reloadFn = fn;
}

export function registerCommands(context: vscode.ExtensionContext): void {
  const treeView = getTreeView();

  // Resolve the file set a per-file command should act on: the current multi-selection
  // when the clicked row is part of it, otherwise just the clicked row.
  const filesFor = (
    element: TreeElement | undefined,
  ): Array<{ path: string; groupName: string }> => {
    const sel = (treeView ? treeView.selection || [] : []).filter(
      (e): e is FileElement => e.kind === 'file',
    );
    const inSel =
      element &&
      element.kind === 'file' &&
      sel.some(e => e.path === element.path && e.groupName === element.groupName);
    if (inSel && sel.length) return sel.map(e => ({ path: e.path, groupName: e.groupName }));
    if (element && element.kind === 'file')
      return [{ path: element.path, groupName: element.groupName }];
    return [];
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('prReviewGroups.openDiff', (p: string) => openDiff(p)),
    vscode.commands.registerCommand(
      'prReviewGroups.openFile',
      async (element: TreeElement | undefined) => {
        const relPath = element && element.kind === 'file' ? element.path : undefined;
        if (!relPath) return;
        const uri = vscode.Uri.file(path.join(getRepoRoot(), relPath));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      },
    ),
    vscode.commands.registerCommand(
      'prReviewGroups.moveFile',
      async (element: TreeElement | undefined) => {
        const files = filesFor(element);
        const config = getConfig();
        if (!files.length || !config) return;
        interface MovePick extends vscode.QuickPickItem {
          _new?: boolean;
          _ungrouped?: boolean;
        }
        const NEW: MovePick = { label: '$(add) New group…', _new: true };
        const UNGRP: MovePick = {
          label: `$(circle-slash) ${UNGROUPED_NAME}`,
          _ungrouped: true,
        };
        const groupItems: MovePick[] = config.groups.map(g => ({
          label: g.name,
          description: `${g.files.length} file${g.files.length === 1 ? '' : 's'}`,
        }));
        const pick = await vscode.window.showQuickPick([NEW, UNGRP, ...groupItems], {
          placeHolder:
            files.length > 1
              ? `Move ${files.length} files to…`
              : `Move ${path.basename(files[0].path)} to…`,
        });
        if (!pick) return;
        if (pick._ungrouped) return markUngrouped(files);
        const dest = pick._new ? await promptNewGroup() : pick.label;
        if (dest) moveFiles(files, dest);
      },
    ),
    vscode.commands.registerCommand(
      'prReviewGroups.markUngrouped',
      (element: TreeElement | undefined) => {
        const files = filesFor(element);
        if (files.length) markUngrouped(files);
      },
    ),
    vscode.commands.registerCommand('prReviewGroups.newGroup', () => promptNewGroup()),
    vscode.commands.registerCommand('prReviewGroups.createFirstGroup', () => startManual()),
    vscode.commands.registerCommand('prReviewGroups.setupFromPR', () => setupFromPR()),
    vscode.commands.registerCommand('prReviewGroups.linkPR', () => linkPR()),
    vscode.commands.registerCommand('prReviewGroups.setSlack', () => setSlack()),
    vscode.commands.registerCommand('prReviewGroups.setJira', () => setJira()),
    vscode.commands.registerCommand('prReviewGroups.openSettings', () => openSettings()),
    vscode.commands.registerCommand('prReviewGroups.openJira', () => {
      const config = getConfig();
      const j = config && config.pr && config.pr.jira;
      if (j) vscode.env.openExternal(vscode.Uri.parse(j));
      else vscode.window.showWarningMessage('PR Review Groups: no JIRA ticket set (pr.jira).');
    }),
    vscode.commands.registerCommand('prReviewGroups.signInAndDetect', async () => {
      await getToken();
      if (reloadFn) await reloadFn();
    }),
    vscode.commands.registerCommand(
      'prReviewGroups.renameGroup',
      (element: TreeElement | undefined) => {
        const name = element && element.kind === 'group' ? element.group.name : null;
        if (name) renameGroup(name);
      },
    ),
    vscode.commands.registerCommand(
      'prReviewGroups.deleteGroup',
      (element: TreeElement | undefined) => {
        const name = element && element.kind === 'group' ? element.group.name : null;
        if (name) deleteGroup(name);
      },
    ),
    vscode.commands.registerCommand(
      'prReviewGroups.setGroupIcon',
      (element: TreeElement | undefined) => {
        const name = element && element.kind === 'group' ? element.group.name : null;
        if (name) setGroupIcon(name);
      },
    ),
    vscode.commands.registerCommand(
      'prReviewGroups.setGroupDescription',
      (element: TreeElement | undefined) => {
        const name = element && element.kind === 'group' ? element.group.name : null;
        if (name) setGroupDescription(name);
      },
    ),
    vscode.commands.registerCommand('prReviewGroups.openOnGitHub', (url?: string) => {
      const config = getConfig();
      const target = url || (config && config.pr && config.pr.url);
      if (target) vscode.env.openExternal(vscode.Uri.parse(target));
      else vscode.window.showWarningMessage('PR Review Groups: no PR url in config (pr.url).');
    }),
    vscode.commands.registerCommand('prReviewGroups.openSlack', () => {
      const config = getConfig();
      const pr = (config && config.pr) || {};
      if (!pr.slack) {
        vscode.window.showWarningMessage('PR Review Groups: no Slack thread in config (pr.slack).');
        return;
      }
      const deep = slackDeepLink(pr.slack, pr.slackTeam);
      vscode.env.openExternal(vscode.Uri.parse(deep || pr.slack));
    }),
    vscode.commands.registerCommand('prReviewGroups.reload', () => reloadFn?.()),
    vscode.commands.registerCommand('prReviewGroups.openConfig', async () => {
      const p = configPath();
      if (fs.existsSync(p)) {
        const doc = await vscode.workspace.openTextDocument(p);
        await vscode.window.showTextDocument(doc);
      } else {
        vscode.window.showWarningMessage(`No config at ${p}`);
      }
    }),
    vscode.commands.registerCommand('prReviewGroups.findFiles', async () => {
      await vscode.commands.executeCommand('prReviewGroups.tree.focus');
      await vscode.commands.executeCommand('list.find');
    }),
    vscode.commands.registerCommand('prReviewGroups.showUnviewedOnly', async () => {
      setUnviewedOnly(true);
      persist('prReviewGroups.unviewedOnly', true);
      await vscode.commands.executeCommand('setContext', 'prReviewGroups.unviewedOnly', true);
      const provider = getProvider();
      if (provider) provider.refresh();
    }),
    vscode.commands.registerCommand('prReviewGroups.showAllFiles', async () => {
      setUnviewedOnly(false);
      persist('prReviewGroups.unviewedOnly', false);
      await vscode.commands.executeCommand('setContext', 'prReviewGroups.unviewedOnly', false);
      const provider = getProvider();
      if (provider) provider.refresh();
    }),
    vscode.commands.registerCommand('prReviewGroups.showNested', async () => {
      setNestedMode(true);
      persist('prReviewGroups.nested', true);
      await vscode.commands.executeCommand('setContext', 'prReviewGroups.nested', true);
      const provider = getProvider();
      if (provider) provider.refresh();
    }),
    vscode.commands.registerCommand('prReviewGroups.showFlat', async () => {
      setNestedMode(false);
      persist('prReviewGroups.nested', false);
      await vscode.commands.executeCommand('setContext', 'prReviewGroups.nested', false);
      const provider = getProvider();
      if (provider) provider.refresh();
    }),
  );
}
