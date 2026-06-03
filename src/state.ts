import * as vscode from 'vscode';

// ---------- constants ----------

export const BASE_SCHEME = 'prreview-base';
export const GROUP_SCHEME = 'prreview-group';
export const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
export const DND_MIME = 'application/vnd.code.tree.prreview';
export const UNGROUPED_NAME = 'Ungrouped';

// ---------- types ----------

export interface GroupCfg {
  name: string;
  description?: string;
  files: string[];
  icon?: string;
}

export interface PrMeta {
  owner?: string;
  repo?: string;
  number?: number;
  id?: string;
  base?: string;
  title?: string;
  url?: string;
  slack?: string;
  slackTeam?: string;
  jira?: string;
  [k: string]: unknown;
}

export interface Config {
  pr?: PrMeta;
  groups: GroupCfg[];
}

export interface DiffStat {
  additions: number;
  deletions: number;
  files: number;
}

export interface BranchPRFound {
  state: 'found';
  pr: {
    id: string;
    number: number;
    title: string;
    url: string;
    base: string;
    owner: string;
    repo: string;
  };
}

export type BranchPR =
  | { state: 'loading' | 'found' | 'none' | 'noauth' | 'error' | 'idle' }
  | BranchPRFound;

// ---------- tree element types ----------

export interface GroupElement {
  kind: 'group';
  group: GroupCfg;
}

export interface FolderElement {
  kind: 'folder';
  groupName: string;
  prefix: string;
  label?: string;
}

export interface FileElement {
  kind: 'file';
  path: string;
  groupName: string;
}

export interface PlaceholderElement {
  kind: 'placeholder';
  variant: 'empty' | 'allViewed';
  groupName: string;
  label: string;
}

export type TreeElement = GroupElement | FolderElement | FileElement | PlaceholderElement;

// ---------- module-level mutable state ----------

let config: Config | null = null;
export function getConfig(): Config | null {
  return config;
}
export function setConfig(c: Config | null): void {
  config = c;
}

// path -> viewed
export const viewed: Map<string, boolean> = new Map();

let unviewedOnly = false;
export function getUnviewedOnly(): boolean {
  return unviewedOnly;
}
export function setUnviewedOnly(v: boolean): void {
  unviewedOnly = v;
}

let nestedMode = false;
export function getNestedMode(): boolean {
  return nestedMode;
}
export function setNestedMode(v: boolean): void {
  nestedMode = v;
}

let extContext: vscode.ExtensionContext | null = null;
export function getExtContext(): vscode.ExtensionContext | null {
  return extContext;
}
export function setExtContext(c: vscode.ExtensionContext | null): void {
  extContext = c;
}

let loadingViewed = false;
export function getLoadingViewed(): boolean {
  return loadingViewed;
}
export function setLoadingViewed(v: boolean): void {
  loadingViewed = v;
}

let diffStat: DiffStat | null = null;
export function getDiffStat(): DiffStat | null {
  return diffStat;
}
export function setDiffStat(s: DiffStat | null): void {
  diffStat = s;
}

let ungroupedFiles: string[] = [];
export function getUngroupedFiles(): string[] {
  return ungroupedFiles;
}
export function setUngroupedFiles(files: string[]): void {
  ungroupedFiles = files;
}

let branchPR: BranchPR | null = null;
export function getBranchPR(): BranchPR | null {
  return branchPR;
}
export function setBranchPR(b: BranchPR | null): void {
  branchPR = b;
}

let suppressWatch = false;
export function getSuppressWatch(): boolean {
  return suppressWatch;
}
export function setSuppressWatch(v: boolean): void {
  suppressWatch = v;
}

let repoRoot = '';
export function getRepoRoot(): string {
  return repoRoot;
}
export function setRepoRoot(r: string): void {
  repoRoot = r;
}

let prNodeId = '';
export function getPrNodeId(): string {
  return prNodeId;
}
export function setPrNodeId(id: string): void {
  prNodeId = id;
}

// ---------- runtime providers (set during activate) ----------
// These are typed minimally to avoid circular imports; the consumers cast as needed.

export interface ProviderLike {
  refresh(): void;
  nextFile(path: string, groupName: string): FileElement | null;
}

let provider: ProviderLike | null = null;
export function getProvider(): ProviderLike | null {
  return provider;
}
export function setProvider(p: ProviderLike | null): void {
  provider = p;
}

let treeView: vscode.TreeView<TreeElement> | null = null;
export function getTreeView(): vscode.TreeView<TreeElement> | null {
  return treeView;
}
export function setTreeView(t: vscode.TreeView<TreeElement> | null): void {
  treeView = t;
}

export interface HeaderProviderLike {
  post(): void;
}

let headerProvider: HeaderProviderLike | null = null;
export function getHeaderProvider(): HeaderProviderLike | null {
  return headerProvider;
}
export function setHeaderProvider(h: HeaderProviderLike | null): void {
  headerProvider = h;
}

export interface GroupDecorationLike {
  refresh(): void;
}

let groupDecoration: GroupDecorationLike | null = null;
export function getGroupDecoration(): GroupDecorationLike | null {
  return groupDecoration;
}
export function setGroupDecoration(g: GroupDecorationLike | null): void {
  groupDecoration = g;
}

// ---------- output channel / log ----------

let output: vscode.OutputChannel | null = null;
export function getOutput(): vscode.OutputChannel | null {
  return output;
}
export function setOutput(o: vscode.OutputChannel | null): void {
  output = o;
}

export function log(msg: string): void {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// ---------- persistence helper ----------

export function persist(key: string, value: unknown): void {
  if (extContext) extContext.workspaceState.update(key, value);
}
