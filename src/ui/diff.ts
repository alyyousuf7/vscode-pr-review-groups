import * as vscode from 'vscode';
import * as path from 'node:path';
import { BASE_SCHEME, getConfig, getRepoRoot } from '../state';

export async function openDiff(relPath: string): Promise<void> {
  const config = getConfig();
  const base = (config && config.pr && config.pr.base) || 'master';
  const leftUri = vscode.Uri.from({ scheme: BASE_SCHEME, path: '/' + relPath, query: base });
  const rightUri = vscode.Uri.file(path.join(getRepoRoot(), relPath));
  const title = `${path.basename(relPath)} (${base} ↔ working)`;
  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
}
