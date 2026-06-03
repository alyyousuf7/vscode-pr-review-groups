import * as vscode from 'vscode';
import {
  GITHUB_GRAPHQL,
  getConfig,
  getPrNodeId,
  setPrNodeId,
  viewed,
  log,
  type BranchPR,
} from '../state';
import { gitCurrentBranch, gitRemoteOwnerRepo } from './git';

// GraphQL responses are intentionally `any` — the upstream schema is large and the
// few fields we touch are checked at the call site.
 
type GraphQLData = any;

export async function getToken(): Promise<string | null> {
  const session = await vscode.authentication.getSession('github', ['repo'], {
    createIfNone: true,
  });
  return session ? session.accessToken : null;
}

export async function getTokenSilent(): Promise<string | null> {
  try {
    const s = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
    return s ? s.accessToken : null;
  } catch {
    return null;
  }
}

export async function graphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLData> {
  const res = await fetch(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pr-review-groups',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as GraphQLData;
  if (json.errors) {
    throw new Error(json.errors.map((e: { message: string }) => e.message).join('; '));
  }
  return json.data;
}

export async function fetchViewedState(): Promise<void> {
  const config = getConfig();
  if (!config || !config.pr) return;
  if (!config.pr.owner || !config.pr.repo || !config.pr.number) return;
  const token = await getToken();
  if (!token) {
    vscode.window.showWarningMessage(
      'PR Review Groups: no GitHub session; checkboxes will not reflect GitHub.',
    );
    return;
  }
  const { owner, repo, number } = config.pr;
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        id
        files(first:100, after:$cursor){
          nodes{ path viewerViewedState }
          pageInfo{ hasNextPage endCursor }
        }
      }
    }
  }`;
  let cursor: string | null = null;
  let pages = 0;
  try {
    do {
      const data: GraphQLData = await graphql(token, query, { owner, repo, number, cursor });
      const pr = data.repository.pullRequest;
      if (pr && pr.id && !getPrNodeId()) setPrNodeId(pr.id);
      const files = pr.files;
      for (const n of files.nodes) {
        if (viewed.has(n.path)) viewed.set(n.path, n.viewerViewedState === 'VIEWED');
      }
      cursor = files.pageInfo.hasNextPage ? files.pageInfo.endCursor : null;
      pages++;
    } while (cursor && pages < 50);
    log(`Fetched viewed state across ${pages} page(s).`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`PR Review Groups: failed to fetch viewed state: ${msg}`);
  }
}

export async function setViewedOnGitHub(filePath: string, isViewed: boolean): Promise<void> {
  const token = await getToken();
  if (!token) throw new Error('no GitHub session');
  const prNodeId = getPrNodeId();
  if (!prNodeId) throw new Error('missing PR node id (pr.id in config)');
  const mutation = isViewed
    ? `mutation($prId:ID!,$path:String!){ markFileAsViewed(input:{pullRequestId:$prId, path:$path}){ clientMutationId } }`
    : `mutation($prId:ID!,$path:String!){ unmarkFileAsViewed(input:{pullRequestId:$prId, path:$path}){ clientMutationId } }`;
  await graphql(token, mutation, { prId: prNodeId, path: filePath });
}

// Find the open PR whose head is the current branch, returning everything needed to
// scaffold a config. Used only on the welcome screen (no config yet).
export async function detectBranchPR(): Promise<BranchPR> {
  try {
    const branch = await gitCurrentBranch();
    if (!branch || branch === 'HEAD') return { state: 'none' };
    const nwo = await gitRemoteOwnerRepo();
    if (!nwo) return { state: 'none' };
    const token = await getTokenSilent();
    if (!token) return { state: 'noauth' };
    const query = `query($owner:String!,$repo:String!,$head:String!){
      repository(owner:$owner,name:$repo){
        pullRequests(headRefName:$head, first:1, states:OPEN, orderBy:{field:UPDATED_AT, direction:DESC}){
          nodes{ id number title url baseRefName }
        }
      }
    }`;
    const data: GraphQLData = await graphql(token, query, {
      owner: nwo.owner,
      repo: nwo.repo,
      head: branch,
    });
    const node = data && data.repository && data.repository.pullRequests.nodes[0];
    if (!node) return { state: 'none' };
    return {
      state: 'found',
      pr: {
        id: node.id,
        number: node.number,
        title: node.title,
        url: node.url,
        base: node.baseRefName,
        owner: nwo.owner,
        repo: nwo.repo,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('PR detection failed: ' + msg);
    return { state: 'error' };
  }
}
