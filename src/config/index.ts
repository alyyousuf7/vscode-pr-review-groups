import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  getConfig,
  setConfig,
  setRepoRoot,
  setPrNodeId,
  setSuppressWatch,
  getRepoRoot,
  viewed,
  log,
  type Config,
} from '../state';
import { workspaceRoot, gitOut } from '../remote/git';

export function configPath(): string {
  return path.join(workspaceRoot(), '.vscode', 'review-groups.json');
}

export function loadConfig(): boolean {
  const p = configPath();
  if (!fs.existsSync(p)) {
    setConfig(null);
    return false;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Config;
    setConfig(cfg);
    setRepoRoot(workspaceRoot());
    setPrNodeId(cfg.pr && cfg.pr.id ? cfg.pr.id : '');
    viewed.clear();
    for (const g of cfg.groups || []) {
      for (const f of g.files || []) {
        if (!viewed.has(f)) viewed.set(f, false);
      }
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`PR Review Groups: failed to parse config: ${msg}`);
    setConfig(null);
    return false;
  }
}

// Persist the in-memory config back to disk. The synthetic "Ungrouped" group is
// not part of config.groups, so it's never serialized.
export function writeConfig(): void {
  const config = getConfig();
  if (!config) return;
  setSuppressWatch(true);
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
  setTimeout(() => {
    setSuppressWatch(false);
  }, 1500);
}

// Best guess for the PR base branch when scaffolding a hand-made config.
export function defaultBaseBranch(): Promise<string> {
  return new Promise(resolve => {
    execFile(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: workspaceRoot() },
      (err, stdout) => {
        if (!err && stdout && stdout.trim()) return resolve(stdout.trim().replace(/^origin\//, ''));
        resolve('master');
      },
    );
  });
}

// True when the config carries enough PR metadata to sync viewed state with GitHub.
export function usesGitHub(): boolean {
  const config = getConfig();
  return !!(
    config &&
    config.pr &&
    config.pr.id &&
    config.pr.owner &&
    config.pr.repo &&
    config.pr.number
  );
}

// Extract a JIRA key (e.g. EXP-1234) from a URL/string for display; fall back to input.
export function jiraKeyOf(s: string | undefined): string {
  const m = String(s || '').match(/([A-Z][A-Z0-9]+-\d+)/);
  return m ? m[1] : String(s || '');
}

// User-configured JIRA browse base (e.g. https://acme.atlassian.net/browse/). Lets a
// bare ticket key be expanded into a full URL. Stored as a VSCode setting, not in config.
export function jiraBaseUrl(): string {
  return (
    vscode.workspace.getConfiguration('prReviewGroups').get<string>('jiraBaseUrl') || ''
  ).trim();
}

export function joinJira(base: string, key: string): string {
  if (!base) return key;
  return base.replace(/\/+$/, '') + '/' + key.replace(/^\/+/, '');
}

export async function saveJiraBase(base: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('prReviewGroups')
    .update('jiraBaseUrl', base, vscode.ConfigurationTarget.Global);
}

// Split a JIRA URL into { base, key } (base is everything up to the ticket key), or null.
export function splitJira(url: string): { base: string; key: string } | null {
  const m = String(url).match(/^(.*?)([A-Z][A-Z0-9]+-\d+)\b/);
  return m ? { base: m[1], key: m[2] } : null;
}

// Make the config file invisible to git locally via .git/info/exclude — a per-clone
// ignore list that is never committed and doesn't touch the repo's tracked .gitignore.
// No-op if the path is already ignored, or if disabled via the gitExclude setting.
export async function ensureGitExclude(): Promise<void> {
  if (!getConfig()) return;
  if (!vscode.workspace.getConfiguration('prReviewGroups').get('gitExclude', true)) return;
  const cfgPath = configPath();
  try {
    if (await gitOut(['check-ignore', cfgPath])) return;
    const top = await gitOut(['rev-parse', '--show-toplevel']);
    let commonDir = await gitOut(['rev-parse', '--git-common-dir']);
    if (!top || !commonDir) return;
    if (!path.isAbsolute(commonDir)) {
      commonDir = path.resolve(getRepoRoot(), commonDir);
    }
    const excludeFile = path.join(commonDir, 'info', 'exclude');
    const pattern = '/' + path.relative(top, cfgPath).split(path.sep).join('/');
    let body = '';
    try {
      body = fs.readFileSync(excludeFile, 'utf8');
    } catch {
      /* ignore */
    }
    const prefix = body && !body.endsWith('\n') ? '\n' : '';
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(
      excludeFile,
      `${prefix}# PR Review Groups (local tooling)\n${pattern}\n`,
      'utf8',
    );
    log(`Added to .git/info/exclude: ${pattern}`);
    vscode.window.setStatusBarMessage(
      `PR Review Groups: hid ${pattern} from git (local .git/info/exclude)`,
      4000,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`gitExclude failed: ${msg}`);
  }
}
