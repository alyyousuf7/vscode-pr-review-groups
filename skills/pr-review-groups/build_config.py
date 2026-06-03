#!/usr/bin/env python3
"""Generate .vscode/review-groups.json for the "PR Review Groups" VSCode extension.

Resolves PR metadata + changed files via `gh`, applies a default grouping
(Tests / Source / Config & lockfile / Docs / Other), and writes the config.

Usage:
  build_config.py [PR_NUMBER] [--base BRANCH] [--out PATH] [--repo OWNER/REPO]

If PR_NUMBER is omitted, the PR for the current branch is used.
After writing, refine groups by editing the JSON (the extension reloads on save)
or by re-running with a custom grouping produced upstream.
"""
import argparse
import json
import os
import re
import subprocess
import sys


def gh_json(args):
    out = subprocess.check_output(["gh"] + args, text=True)
    return json.loads(out)


def resolve_pr(number, repo):
    # NOTE: do NOT request "files" here — `gh pr view --json files` is capped at
    # 100 files and silently truncates large PRs. Get the file list separately.
    # Lines added/removed are NOT stored — the extension computes them live from git.
    fields = "id,number,title,url,baseRefName,headRefName"
    args = ["pr", "view"]
    if number:
        args.append(str(number))
    args += ["--json", fields]
    if repo:
        args += ["--repo", repo]
    pr = gh_json(args)
    # owner/repo
    nwo = repo
    if not nwo:
        try:
            nwo = gh_json(["repo", "view", "--json", "nameWithOwner"])["nameWithOwner"]
        except Exception:
            nwo = "/"
    owner, _, name = nwo.partition("/")
    return pr, owner, name


def changed_files(number, base, repo):
    """Full changed-file list (unbounded). Prefer local git; fall back to gh."""
    # Local git is unbounded and reliable when the PR branch is checked out.
    try:
        out = subprocess.check_output(
            ["git", "diff", "--name-only", f"{base}...HEAD"],
            text=True, stderr=subprocess.DEVNULL,
        )
        files = [l for l in out.splitlines() if l.strip()]
        if files:
            return files
    except Exception:
        pass
    # Fallback: gh pr diff --name-only (not subject to the 100-file --json cap).
    args = ["pr", "diff"]
    if number:
        args.append(str(number))
    args.append("--name-only")
    if repo:
        args += ["--repo", repo]
    out = subprocess.check_output(["gh"] + args, text=True)
    return [l for l in out.splitlines() if l.strip()]


TEST_RE = re.compile(r"(\.spec\.|\.test\.|__tests?__|setupTest|jest\.(config|setup)|/jest/)")
DOC_RE = re.compile(r"\.(md|mdx)$")
SRC_RE = re.compile(r"\.(jsx?|tsx?|mjs|cjs|vue|svelte)$")
LOCK_NAMES = {"yarn.lock", "package-lock.json", "pnpm-lock.yaml", "package.json"}
CONFIG_RE = re.compile(r"(\.config\.(js|ts|cjs|mjs|json)$|^\.|\.json$|\.ya?ml$|\.toml$|tsconfig)")


def classify(paths):
    tests, source, config, docs, other = [], [], [], [], []
    for p in paths:
        base = os.path.basename(p)
        if TEST_RE.search(p):
            tests.append(p)
        elif DOC_RE.search(p):
            docs.append(p)
        elif SRC_RE.search(p):
            source.append(p)
        elif base in LOCK_NAMES or CONFIG_RE.search(p):
            config.append(p)
        else:
            other.append(p)
    for lst in (tests, source, config, docs, other):
        lst.sort()
    # (name, description, files, codicon-id) — icon omitted when "" (no close match).
    groups = [
        ("Source", "Application source changes", source, "code"),
        ("Tests", "Test files & jest setup", tests, "beaker"),
        ("Config & lockfile", "package.json, configs, lockfiles", config, "settings-gear"),
        ("Docs", "Markdown / docs", docs, "book"),
        ("Other", "Uncategorized changed files", other, ""),
    ]
    out = []
    for (n, d, f, icon) in groups:
        if not f:
            continue
        g = {"name": n, "description": d, "files": f}
        if icon:
            g["icon"] = icon
        out.append(g)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("number", nargs="?", help="PR number (default: current branch)")
    ap.add_argument("--base", help="base branch ref (default: PR baseRefName)")
    ap.add_argument("--repo", help="OWNER/REPO (default: current repo)")
    ap.add_argument("--slack", help="Slack thread URL for this PR's discussion (optional)")
    ap.add_argument("--jira", help="JIRA ticket URL (optional)")
    ap.add_argument("--slack-team", dest="slack_team", help="Slack team id (T...) — optional; disambiguates multiple signed-in workspaces")
    ap.add_argument("--out", default=".vscode/review-groups.json")
    args = ap.parse_args()

    pr, owner, name = resolve_pr(args.number, args.repo)
    base = args.base or pr.get("baseRefName") or "master"
    paths = changed_files(args.number, base, args.repo)
    groups = classify(paths)
    jira = (args.jira or "").strip()

    config = {
        "pr": {
            "owner": owner,
            "repo": name,
            "number": pr["number"],
            "id": pr["id"],
            "base": base,
            "title": pr.get("title", ""),
            "url": pr.get("url", ""),
            "slack": args.slack or "",
            "slackTeam": args.slack_team or "",
            "jira": jira,
        },
        "groups": groups,
    }

    out = args.out
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w") as fh:
        json.dump(config, fh, indent=2, ensure_ascii=False)

    print(f"Wrote {out}")
    print(f"PR #{pr['number']}: {pr.get('title','')}")
    print(f"Base: {base} · {len(paths)} changed files")
    for g in groups:
        print(f"  {g['name']}: {len(g['files'])}")


if __name__ == "__main__":
    sys.exit(main())
