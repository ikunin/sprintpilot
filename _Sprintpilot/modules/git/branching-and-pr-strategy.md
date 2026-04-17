# Git Branching and PR Strategy

How the Sprintpilot manages branches, PRs, and merging across stories.

## Configuration

Controlled by `git.push.create_pr` in `modules/git/config.yaml`:

```yaml
git:
  push:
    create_pr: true   # PR flow — create PR, no auto-merge, wait for approval
    create_pr: false   # Direct merge — merge story branch to main after push
```

## Branch Naming

Each story gets a branch: `story/{story-key}` (e.g., `story/1-2-user-authentication`).

The story key is derived from `sprint-status.yaml`. If the key is numeric-only (e.g., `1-2`), the autopilot enriches it from the story file or epics file to produce a human-readable branch name.

Branch names are sanitized (lowercased, special chars removed) and truncated to 60 characters with a hash suffix if longer.

## Direct Merge Flow (`create_pr: false`)

```
main ─── story/1-1 ──→ merge to main ─── story/1-2 ──→ merge to main
```

Each story:
1. Branches from `origin/main`
2. Code is developed in a worktree
3. Branch is pushed to origin
4. Branch is merged directly to main: `git merge story/1-1 --no-edit`
5. Main is pushed to origin

The next story always branches from the updated main.

## PR Flow (`create_pr: true`)

When PRs are enabled, stories are **never auto-merged**. The branch is pushed and a PR is created. Merging happens through the platform's PR review process.

### Single story (or first story in epic)

```
main ─── story/1-1 ──→ push + PR (story/1-1 → main)
```

1. Branches from `origin/main`
2. Code is developed in a worktree
3. Branch is pushed to origin
4. PR is created targeting `main`
5. No merge — PR awaits approval

### Stacked stories (subsequent stories, previous PR pending)

```
main ─── story/1-1 ──→ PR (→ main)
              └── story/1-2 ──→ PR (→ story/1-1)
                       └── story/1-3 ──→ PR (→ story/1-2)
```

When the previous story's PR is not yet merged:
1. The autopilot detects the unmerged branch via `git-status.yaml` and `git merge-base --is-ancestor`
2. New story branches from `origin/story/<previous-story>` instead of main
3. PR targets the previous story branch (not main)
4. This creates a stacked PR chain

### After PR merge (between sessions)

When story/1-1's PR is merged on the platform before the next session:
1. `git merge-base --is-ancestor origin/story/1-1 origin/main` returns true
2. The autopilot detects that 1-1 is now on main
3. Story/1-2 branches from `origin/main` (which includes 1-1's code)
4. PR targets `main`

GitHub, GitLab, and Bitbucket automatically retarget stacked PRs when the base is merged.

## Decision Matrix

| Config | Previous story | Branch source | PR target | Post-push action |
|--------|---------------|---------------|-----------|-----------------|
| `create_pr: false` | Any | `origin/main` | N/A | Merge to main |
| `create_pr: true` | None or merged | `origin/main` | `main` | PR created, no merge |
| `create_pr: true` | Unmerged (PR pending) | `origin/story/<prev>` | `story/<prev>` | PR created, no merge |

## Session Persistence

The PR target branch (`pr_base`) is saved in `autopilot-state.yaml` and restored on session resume. This ensures that a resumed session creates PRs against the correct base branch even if it was a stacked story.

## Artifacts on Main

Regardless of the merge strategy, implementation artifacts (sprint-status.yaml, git-status.yaml, story files, planning documents) are always committed and pushed to main after each story completes. This ensures main reflects the current sprint state even when story code is on PR branches.

## File Ownership

| File | Owner | Autopilot access |
|------|-------|-----------------|
| `sprint-status.yaml` | BMad Method (dev-story, sprint-planning, retrospective) | Read only |
| `git-status.yaml` | Autopilot addon | Read/write |
| `autopilot-state.yaml` | Autopilot addon | Read/write |
