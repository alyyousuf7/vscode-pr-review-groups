import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { getConfig, getRepoRoot, type DiffStat } from '../state';

export function workspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : '';
}

export function gitOut(args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile('git', args, { cwd: getRepoRoot() || workspaceRoot() }, (err, out) => {
      resolve(err || !out ? '' : out.trim());
    });
  });
}

export function gitCurrentBranch(): Promise<string> {
  return new Promise(resolve => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceRoot() }, (err, out) => {
      resolve(err || !out ? '' : out.trim());
    });
  });
}

export function gitRemoteOwnerRepo(): Promise<{ owner: string; repo: string } | null> {
  return new Promise(resolve => {
    execFile('git', ['remote', 'get-url', 'origin'], { cwd: workspaceRoot() }, (err, out) => {
      if (err || !out) return resolve(null);
      const m = out.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
      resolve(m ? { owner: m[1], repo: m[2] } : null);
    });
  });
}

export function gitShow(ref: string, relPath: string): Promise<string> {
  return new Promise(resolve => {
    execFile(
      'git',
      ['show', `${ref}:${relPath}`],
      { cwd: getRepoRoot(), maxBuffer: 50 * 1024 * 1024 },
      (err, stdout) => {
        // File may not exist at base (newly added) -> empty left side.
        resolve(err ? '' : stdout);
      },
    );
  });
}

// Live lines added/removed from the local branch vs base (merge-base, matching
// GitHub PR semantics). Returns null if git fails (e.g. base ref missing).
export function computeDiffStat(): Promise<DiffStat | null> {
  return new Promise(resolve => {
    const config = getConfig();
    const base = (config && config.pr && config.pr.base) || 'master';
    execFile(
      'git',
      ['diff', '--shortstat', `${base}...HEAD`],
      { cwd: getRepoRoot(), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const add = /(\d+) insertion/.exec(stdout);
        const del = /(\d+) deletion/.exec(stdout);
        const files = /(\d+) files? changed/.exec(stdout);
        resolve({
          additions: add ? +add[1] : 0,
          deletions: del ? +del[1] : 0,
          files: files ? +files[1] : 0,
        });
      },
    );
  });
}

// All changed file paths in the PR vs base (merge-base). Used to find files that
// were added to the PR after the grouping config was generated.
export function listChangedFiles(): Promise<string[]> {
  return new Promise(resolve => {
    const config = getConfig();
    const base = (config && config.pr && config.pr.base) || 'master';
    execFile(
      'git',
      ['diff', '--name-only', `${base}...HEAD`],
      { cwd: getRepoRoot(), maxBuffer: 50 * 1024 * 1024 },
      (err, stdout) => {
        resolve(err || !stdout ? [] : stdout.split('\n').filter(Boolean));
      },
    );
  });
}
