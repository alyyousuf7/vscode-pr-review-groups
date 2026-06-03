---
name: pr-review-groups
description: Set up grouped review of a PR in the "PR Review Groups" VSCode extension — buckets the PR's changed files into clickable groups with per-file GitHub viewed-state sync, opening base...head diffs on click, by generating a .vscode/review-groups.json. Optionally accepts a custom grouping scheme (by domain, by change type, "mechanical vs needs-review", risk tiers, etc.).
when_to_use: When the user wants to review a PR in VSCode or organize a PR's files for review — e.g. "review the PR", "review this PR", "let's review PR 1234", "help me review the PR", "I want to go through this PR file by file", "create review groups for PR 1234", "group the PR files for review", "set up review buckets". Not for posting code-review comments or running automated code review — this only sets up the in-editor reviewing workspace.
---

# PR Review Groups

Generate `.vscode/review-groups.json` for the **PR Review Groups** VSCode extension: it
buckets a PR's changed files into clickable groups, opens `base...head` diffs on click,
and syncs each file's reviewed checkbox to GitHub's viewed state. This skill produces the
config; the links, icons, and grouping are all editable in-extension afterward.

## Config shape

```json
{
  "pr": {
    "owner": "your-org",
    "repo": "your-repo",
    "number": 1234,
    "id": "PR_kwDO...", // GraphQL node id — REQUIRED for viewed-state sync
    "base": "main",
    "title": "Refactor auth module",
    "url": "https://github.com/your-org/your-repo/pull/1234",
    "slack": "https://your-workspace.slack.com/archives/C01234567/p1700000000000000", // optional
    "jira": "https://your-org.atlassian.net/browse/PROJ-123" // optional
  },
  "groups": [
    {
      "name": "Mechanical renames",
      "description": "Skim",
      "icon": "replace-all",
      "files": ["pkg/A.jsx", "..."]
    }
  ]
}
```

- Put each file in at most one group — the extension does not dedupe (a file listed in
  two groups shows up twice). Files you leave out are auto-collected under an **Ungrouped**
  group, so don't force ambiguous files into a vague catch-all — just omit them.
- `pr.id` (GraphQL node id) is **required** for viewed-state sync.
- `icon` is an optional bare codicon id per group (no `$(...)`); defaults to `collection`.

## Steps

1. **Resolve the PR** — use the given number/URL, else the current branch's PR. Confirm if ambiguous.

2. **Run the helper** from the repo root (the branch must be checked out locally for diffs to render). The helper is bundled alongside this `SKILL.md`; invoke it via the absolute base directory the skill loader exposed:

   ```bash
   python3 <skill-base-dir>/build_config.py [PR_NUMBER]
   ```

   Fetches PR metadata via `gh`, the changed-file list via `git diff base...HEAD` (avoids
   the `gh --json files` 100-file cap), and writes a default grouping (Source / Tests /
   Config & lockfile / Docs / Other). Flags: `--base`, `--repo OWNER/REPO`, `--slack <url>`,
   `--slack-team <T…>`, `--jira <url>`, `--out`.

3. **Custom grouping** (when asked — by domain, change type, risk, "mechanical vs needs-review", …):
   - List files locally: `git diff --name-only <base>...HEAD` (fall back to `gh pr diff <n> --name-only`).
     Read diffs to classify: `git diff <base>...HEAD -- <path>`.
   - For large PRs (>~100 files), delegate the per-file classification to a subagent (or a
     Workflow if the user opted in) with crisp bucket criteria.
   - Group only the files that cluster meaningfully; leave genuinely miscellaneous files out
     (they land under **Ungrouped** automatically) rather than inventing a vague catch-all.
   - Keep the script's `pr` block; replace only `groups`. Give each group a distinct, relevant
     codicon id (real codicon — https://microsoft.github.io/vscode-codicons/dist/codicon.html;
     e.g. tests→`beaker`, config→`settings-gear`, docs→`book`, styles→`paintcan`, API→`plug`,
     migrations→`arrow-swap`, renames→`replace-all`). Omit `icon` if nothing fits (→ `collection`).

4. **Verify `pr.id`** looks like `PR_…`; otherwise `gh pr view <n> --json id --jq .id`. Without it the checkboxes can't sync.

5. **Optional Slack/JIRA links** — if the PR has a Slack thread or JIRA ticket, set `pr.slack` /
   `pr.jira` (via `--slack` / `--jira`, or the user can add them later from the Overview gear).
   Ask the user; don't fabricate URLs; preserve existing values when regenerating.

6. **Load it** — the extension auto-reloads on save. Diffs need the PR branch checked out (a
   base-branch checkout shows empty diffs); if the view stays empty, reload the window.

## Notes

- PR number is optional (defaults to the current branch); the extension can also self-scaffold
  from the branch's PR, so this skill's real value is the _grouping_, not fetching PR metadata.
- The config is local tooling — the extension auto-adds it to `.git/info/exclude`, so it stays
  out of `git status` without touching the tracked `.gitignore`.
- Viewed-state sync uses VSCode's built-in GitHub session (`repo` scope); `gh` is used only for
  read-side metadata and the node id.
