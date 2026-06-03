import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  getConfig,
  setSuppressWatch,
  setPrNodeId,
  getExtContext,
  getBranchPR,
  viewed,
  log,
  type GroupCfg,
} from '../state';
import { writeConfig, configPath, defaultBaseBranch } from '../config';
import { setViewedOnGitHub, detectBranchPR, getToken } from '../remote/github';
import { localViewedKey } from '../remote/viewed';

// Convert an https Slack archive URL to a slack:// deep link so the desktop app opens
// directly. Requires a team id — Slack won't resolve the channel from a team-less deep
// link (it opens the app but doesn't navigate). Without a team id this returns null and
// the caller falls back to the https url, which Slack's web page then redirects into the
// app at the correct thread. A slack:// link is passed through unchanged.
export function slackDeepLink(url: string | undefined, teamId: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('slack://')) return url;
  if (!teamId) return null;
  const m = url.match(/\/archives\/([A-Z0-9]+)(?:\/p(\d+))?/i);
  if (!m) return null;
  let link = `slack://channel?team=${teamId}&id=${m[1]}`;
  if (m[2] && m[2].length > 6) {
    link += `&message=${m[2].slice(0, -6)}.${m[2].slice(-6)}`;
  }
  return link;
}

// Forward-declared reload — set by extension.ts to avoid a circular import.
let reloadFn: (() => Promise<void>) | null = null;
export function setReload(fn: () => Promise<void>): void {
  reloadFn = fn;
}
async function reload(): Promise<void> {
  if (reloadFn) await reloadFn();
}

// Welcome "Set up review groups": scaffold a config from the detected PR (full pr block,
// so viewed-state syncs to GitHub) plus a first group, then reload.
export async function setupFromPR(): Promise<void> {
  const branchPR = getBranchPR();
  if (!branchPR || branchPR.state !== 'found' || !('pr' in branchPR)) return startManual();
  const name = await vscode.window.showInputBox({
    prompt: 'Name your first group',
    placeHolder: 'e.g. Needs review',
    validateInput: v => (v && v.trim() ? null : 'Name required'),
  });
  if (!name) return;
  const pr = branchPR.pr;
  const cfg = {
    pr: {
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      id: pr.id,
      base: pr.base,
      title: pr.title,
      url: pr.url,
      slack: '',
    },
    groups: [{ name: name.trim(), description: '', files: [] }],
  };
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  setSuppressWatch(true);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  setTimeout(() => {
    setSuppressWatch(false);
  }, 1500);
  await reload();
}

// Attach a GitHub PR to an already-loaded (hand-made / local-only) config: detect the
// branch's PR, merge its metadata into config.pr, migrate locally-viewed files up to
// GitHub, then reload into GitHub-sync mode.
export async function linkPR(): Promise<void> {
  const config = getConfig();
  if (!config) return;
  const result = await vscode.window.withProgress(
    { location: { viewId: 'prReviewGroups.tree' }, title: 'Detecting PR…' },
    () => detectBranchPR(),
  );
  if (result.state === 'noauth') {
    const pick = await vscode.window.showInformationMessage(
      "Sign in to GitHub to detect this branch's PR.",
      'Sign in',
    );
    if (pick === 'Sign in') {
      await getToken();
      return linkPR();
    }
    return;
  }
  if (result.state !== 'found' || !('pr' in result)) {
    vscode.window.showInformationMessage('No open PR found for this branch yet.');
    return;
  }
  const pr = result.pr;
  config.pr = Object.assign({}, config.pr, {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    id: pr.id,
    url: pr.url,
    title: pr.title,
    base: pr.base || (config.pr && config.pr.base) || 'master',
  });
  // Push files marked viewed locally up to GitHub, then drop the local store.
  setPrNodeId(pr.id);
  const locallyViewed = [...viewed].filter(([, v]) => v).map(([k]) => k);
  for (const f of locallyViewed) {
    try {
      await setViewedOnGitHub(f, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`link: failed to push viewed ${f}: ${msg}`);
    }
  }
  const ctx = getExtContext();
  if (ctx) ctx.workspaceState.update(localViewedKey(), {});
  writeConfig();
  await reload();
  vscode.window.showInformationMessage(
    `Linked PR #${pr.number} — viewed state now syncs to GitHub.`,
  );
}

// Manual entry point from the welcome screen: scaffold a config (if absent) and add a
// first group, then reload so the branch's changed files surface under "Ungrouped".
export async function startManual(): Promise<void> {
  const p = configPath();
  let existing: { pr?: { base?: string }; groups?: GroupCfg[] } | null = null;
  if (fs.existsSync(p)) {
    try {
      existing = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      existing = null;
    }
  }
  const config = getConfig();
  const base =
    (existing && existing.pr && existing.pr.base) ||
    (config && config.pr && config.pr.base) ||
    (await defaultBaseBranch());
  const name = await vscode.window.showInputBox({
    prompt: 'Name your first group',
    placeHolder: 'e.g. Needs review',
    validateInput: v => (v && v.trim() ? null : 'Name required'),
  });
  if (!name) return;
  const cfg: { pr: { base?: string; [k: string]: unknown }; groups: GroupCfg[] } =
    existing && typeof existing === 'object'
      ? (existing as { pr: { base?: string }; groups: GroupCfg[] })
      : { pr: {}, groups: [] };
  if (!cfg.pr || typeof cfg.pr !== 'object') cfg.pr = {};
  if (!cfg.pr.base) cfg.pr.base = base;
  if (!Array.isArray(cfg.groups)) cfg.groups = [];
  cfg.groups.push({ name: name.trim(), description: '', files: [] });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  setSuppressWatch(true);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  setTimeout(() => {
    setSuppressWatch(false);
  }, 1500);
  await reload();
}
