import * as vscode from 'vscode';
import { GROUP_SCHEME, viewed } from '../state';
import { findGroup } from '../groups';

// Right-aligned green ✓ badge on fully-viewed groups (via tree file decorations).
export class GroupDecorationProvider implements vscode.FileDecorationProvider {
  private _emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._emitter.event;

  refresh(): void {
    this._emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== GROUP_SCHEME) return undefined;
    const g = findGroup(decodeURIComponent(uri.path.replace(/^\//, '')));
    if (!g || !g.files.length) return undefined;
    const done = g.files.filter(f => viewed.get(f)).length;
    if (done !== g.files.length) return undefined;
    return {
      badge: '✓',
      color: new vscode.ThemeColor('charts.green'),
      tooltip: 'All files reviewed',
    };
  }
}
