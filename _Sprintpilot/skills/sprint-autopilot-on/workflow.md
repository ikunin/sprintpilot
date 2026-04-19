# Sprintpilot — ON (Enhanced with Git Workflow)

## Purpose

You are now in **Sprintpilot Mode** with **git workflow integration**. Drive the project from its current state all the way to a working, tested, reviewed application — following BMAD's own workflow guidance at every step, with automatic git branching, commits, and PR creation.

You do NOT hardcode the workflow sequence. After each completed skill, read its output for a "next steps" recommendation and follow that. Only when no clear next step is in the output do you consult `bmad-help`. BMAD's own output is the primary oracle; `bmad-help` is the fallback.

**Git integration** is additive. If `_Sprintpilot/manifest.yaml` doesn't exist or `git.enabled: false`, all git operations are silently skipped and this workflow behaves identically to the stock autopilot.

### Shell portability (IMPORTANT)

Sprintpilot runs under any LLM CLI (Claude Code, Gemini CLI, Cursor, etc.) on any OS. The shell that executes commands may be **bash, zsh, PowerShell, or cmd** depending on platform and CLI. Shell-specific idioms will fail silently when the wrong shell is used.

**When you encounter bash-style idioms below, translate them to your shell.** The table applies to **external commands** (like `git`); cmdlets have slightly different conventions.

| Bash idiom | PowerShell equivalent | Meaning |
|---|---|---|
| `A && B` | `A; if ($LASTEXITCODE -eq 0) { B }` (or separate commands, guarding B manually) | Run B only if A succeeded |
| `A \|\| true` | `A; $LASTEXITCODE = 0` (or `try { A } catch {}` for cmdlets) | Run A, ignore failures |
| `2>/dev/null` | `2>$null` | Suppress stderr |
| `rm -rf <dir>` | `Remove-Item -Recurse -Force <dir>` | Recursive delete |
| `if [ -f X ]; then ... fi` | `if (Test-Path -PathType Leaf X) { ... }` | File-exists check (regular file, not dir) |

**Safer:** when in doubt, use the cross-platform Node helpers under `_Sprintpilot/scripts/`. For ad-hoc file ops, invoke Node inline: `node -e "require('fs').rmSync('<path>', {recursive: true, force: true})"`.

If a step below uses `&&` to chain "run B only on A's success", and you cannot express that in one line, **run the commands separately and STOP if any step fails** — do not proceed past a failed step.

---

## AUTOPILOT RULES — READ BEFORE PROCEEDING

### Autonomous execution
- After each skill completes, **read its output for a "Next Steps" or "What to do next" section** — that is the primary source for `{{next_skill}}`
- Only invoke `bmad-help` when the completed skill's output contains no clear next step
- Execute each recommended skill immediately — do not wait for user confirmation
- Keep the Claude task list fully in sync with progress at all times

### Session management and compaction prevention — CRITICAL
Long autopilot runs will fill the context window. To prevent state loss:

- **All state lives in files, never only in memory.** After every step, write progress to `{state_file}`.
- **Story boundary = session boundary.** Never split a single story across sessions. Always finish the current story fully (dev → review → patches → done) before ending a session.
- **Proactive session handoff.** After `{{session_story_limit}}` stories have been **fully implemented** in one session (default: 3) — meaning their complete cycle is finished (dev-story GREEN + code-review + patches + artifacts committed) — write state and tell user to start a new session with `/sprint-autopilot-on`. Configurable via `autopilot.session_story_limit` in `modules/autopilot/config.yaml`. Creating a story file does NOT count toward the limit — only finishing step 7 does. Do not wait for compaction to happen.
- **On startup: check for saved state first.** If `{state_file}` exists, this is a RESUME — read it and skip to the saved story/step. Never re-do completed work.

### Menu and interaction handling — CRITICAL
Many BMAD skills present interactive menus or ask for confirmation. In autopilot mode:
- **"Continue" option (C)** → automatically select C, do not halt
- **Numbered choices** → select the best option for the project context; document choice in one sentence
- **"Create Mode"** → always choose it
- **Yes/no confirmation** → always yes
- **Open-ended creative question** → answer from PRD/architecture/existing docs; if truly unanswerable → TRUE BLOCKER
- **NEVER halt at a menu** unless it is a TRUE BLOCKER

### Auto-accept all BMAD suggestions
- Automatically apply ALL `patch`, `bugfix`, and code review findings
- Never ask user for permission on any BMAD-suggested fix
- Only skip a finding if it directly contradicts a story Acceptance Criterion (document why)

### Task list discipline
- Before starting a story, create a task for **each** BMAD step. Track each skill as a task (`in_progress` → `completed`). Never batch updates.
- Always state test results as `N/N passed` or `N passed, M failed` — never say "tests pass" without the count.

### True blockers — the ONLY reasons to pause and ask user
1. Required skill needs **original creative user input** not derivable from any existing artifact
2. A **new external dependency** is needed that is not in the project
3. **3 consecutive test failures** with no forward progress
4. A **security vulnerability** requiring architectural decision beyond the story scope
5. **Conflicting acceptance criteria** that cannot be resolved by reading project documents

For everything else: decide, document briefly, continue.

---

## DECISION LOGGING

Every non-trivial decision made during autopilot execution MUST be logged to `{decision_log_file}`. This creates an audit trail the user reviews at the end of each session.

### When to log

Log a decision whenever you:
- Choose an architecture pattern, data structure, or design approach (`architecture`)
- Select a test strategy or skip a test category (`test-strategy`)
- Add, remove, or substitute a dependency (`dependency`)
- Dismiss a code review finding (`review-triage`)
- Accept and apply a code review finding (`review-accept`)
- Recover from a HALT condition (`halt-recovery`)
- Implement something not explicitly in the story spec (`scope`)
- Apply a workaround for a tool limitation or false positive (`workaround`)

Do NOT log routine actions (running tests, staging files, creating branches).

### File format

Initialize `{decision_log_file}` on first decision (if it does not exist):

```yaml
generated: {current_date}
last_updated: {current_datetime}

decisions: []
```

Append each decision as a new entry:

```yaml
  - id: {auto_increment}
    timestamp: "{current_datetime_iso8601}"
    story: "{current_story or sprint-level}"
    phase: "{skill}:{sub_phase}"
    category: {architecture|test-strategy|dependency|review-triage|review-accept|halt-recovery|scope|workaround}
    decision: "{what was decided — one line}"
    rationale: "{why — one line}"
    impact: {low|medium|high}
```

**Phase format:** `dev-story:RED`, `dev-story:GREEN`, `code-review:triage`, `code-review:patch`, `autopilot:init`, `autopilot:routing`, etc.

**Impact levels:**
- `low` — easily reversible, cosmetic, or standard practice
- `medium` — affects behavior but contained to one story/component
- `high` — cross-cutting, hard to reverse, or deviates from spec

Always update `last_updated` when appending.

---

## SKILL AUTOMATABLE REFERENCE

All BMAD skills are fully automatable (auto-continue past menus, derive decisions from existing artifacts) except:

| Skill | Notes |
|-------|-------|
| `bmad-create-prd` | BLOCKER if no PRD — product vision must come from user |
| `bmad-product-brief` | BLOCKER if no brief — requires user input |
| `bmad-create-architecture` | Automatable if PRD exists; BLOCKER if no PRD |
| `bmad-create-ux-design` | Automatable if PRD exists; BLOCKER if no PRD |
| `bmad-party-mode` | Skip — inherently interactive |
| `bmad-brainstorming` | Skip — inherently interactive |

---

## INITIALIZATION

Load config: `{project-root}/_bmad/bmm/config.yaml`

Resolve:
- `project_name`, `user_name` (user)
- `planning_artifacts`, `implementation_artifacts`
- `status_file` = `{implementation_artifacts}/sprint-status.yaml` (BMAD-owned — written by BMAD skills, not by autopilot)
- `git_status_file` = `{implementation_artifacts}/git-status.yaml` (addon-owned, write git fields here)
- `state_file` = `{implementation_artifacts}/autopilot-state.yaml`
- `decision_log_file` = `{implementation_artifacts}/decision-log.yaml`
- `project_root` = absolute path of current working directory (store for later use)
- `session_story_limit` is loaded below from `modules/autopilot/config.yaml` (default: 3)

### Git integration bootstrap

<action>Check if `{project-root}/_Sprintpilot/manifest.yaml` exists</action>

<check if="manifest exists">
  <action>Read `{project-root}/_Sprintpilot/manifest.yaml`</action>
  <action>Read `{project-root}/_Sprintpilot/modules/git/config.yaml`</action>
  <action>Set config variables from `git.*` fields (defaults in parentheses):
  - `{{git_enabled}}` from `git.enabled` (true)
  - `{{base_branch}}` from `git.base_branch` (main)
  - `{{branch_prefix}}` from `git.branch_prefix` ("story/")
  - `{{push_auto}}` from `git.push.auto` (true)
  - `{{create_pr}}` from `git.push.create_pr` (true)
  - `{{pr_template}}` from `git.push.pr_template` ("modules/git/templates/pr-body.md")
  - `{{cleanup_on_merge}}` from `git.worktree.cleanup_on_merge` (true)
  </action>
  <action>Read `{project-root}/_Sprintpilot/modules/autopilot/config.yaml` (if present) and set:
  - `{{session_story_limit}}` from `autopilot.session_story_limit` (default: 3). A value of 0 disables the limit (run until sprint complete).
  If the file or key is missing, fall back to 3.
  </action>
</check>

<check if="manifest does NOT exist">
  <action>Set `{{git_enabled}}` = false</action>
  <action>Set `{{session_story_limit}}` = 3</action>
  <action>Log: "No _Sprintpilot/manifest.yaml found — running stock autopilot (no git)"</action>
</check>

<check if="{{git_enabled}} is true">
  <action>Verify git repo: run `git rev-parse --git-dir`</action>
  <check if="not a git repo">
    <action>HALT: "No git repository found. Initialize one first:
    ```
    git init
    git add -A
    git commit -m 'initial commit'
    git remote add origin <your-repo-url>
    ```
    Then run /sprint-autopilot-on again."</action>
    <action>STOP</action>
  </check>

  <action>**Lock file** — run: `node {{project_root}}/_Sprintpilot/scripts/lock.js acquire`
  Output will be one of:
  - `ACQUIRED:<session-id>` → proceed
  - `ACQUIRED_STALE:<session-id>` → stale lock removed, proceed
  - `LOCKED:<session-id>:<age>` → another session active
  </action>
  <check if="LOCKED">
    <action>HALT: "Another autopilot session is active. Close it first or delete .autopilot.lock"</action>
    <action>STOP</action>
  </check>

  <action>**Detect platform** — run:
  `node {{project_root}}/_Sprintpilot/scripts/detect-platform.js --provider {{git.platform.provider}}`
  Output: `github`, `gitlab`, or `git_only`. Set `{{platform}}` to the output.
  Log: "Platform detected: {{platform}}"
  </action>

  <action>**Worktree health check** — run:
  `node {{project_root}}/_Sprintpilot/scripts/health-check.js --base-branch {{base_branch}} --status-file {{status_file}}`
  Output classifies each worktree as CLEAN_DONE, COMMITTED, STALE, DIRTY, or ORPHAN.
  - CLEAN_DONE: `git worktree remove .worktrees/<name>` + `git worktree prune`
  - COMMITTED: log "Recoverable work found for <name> — will push via git -C"
    Push the branch: `git -C .worktrees/<name> push -u origin <branch> 2>&1`
    If `{{create_pr}}` is true AND platform != git_only: create PR via `node {{project_root}}/_Sprintpilot/scripts/create-pr.js ...`
    If `{{create_pr}}` is false OR platform is git_only: merge directly. Run each as a separate command; **STOP and log the failure if any step fails — do not proceed past a failed step**:
      1. `git checkout -B {{base_branch}} origin/{{base_branch}}`
      2. `git merge <branch> --no-edit`
      3. `git push origin {{base_branch}}`
    Then remove worktree.
  - STALE: `git worktree remove .worktrees/<name> --force` + prune
  - DIRTY: warn user, ask how to proceed (stash/commit/discard)
  - ORPHAN: remove the directory cross-platform with `node -e "require('fs').rmSync('.worktrees/<name>', {recursive: true, force: true})"`, then `git worktree prune`
  </action>

  <action>**Branch reconciliation** — detect pushed-but-unmerged story branches.
  Run as separate commands — **if `git fetch origin` fails (network/auth), STOP branch reconciliation and log a warning; do not operate on stale local refs**:
    1. `git fetch origin`
    2. `git branch -r --list "origin/{{branch_prefix}}*"`
  For each remote branch:
    - Extract story-key from branch name (strip "origin/{{branch_prefix}}" prefix)
    - Look up story status in `{status_file}`
    - If status is NOT "done":
      - Check if branch has implementation commits beyond base:
        `git log --oneline origin/{{base_branch}}..origin/<branch> | head -5`
      - If commits exist:
        - Log: "RECOVERY: Found unmerged work for <story-key> on <branch>"
        - If `{{platform}}` is git_only OR `{{create_pr}}` is false:
          - Merge to base:
            `git checkout -B {{base_branch}} origin/{{base_branch}}`
            `git merge origin/<branch> --no-edit`
            `git push origin {{base_branch}}`
          - If merge fails: log warning, continue (branch is preserved on remote)
          - If merge succeeds:
            - Re-read `{status_file}` from HEAD (may now include story artifacts after merge)
            - Update `{git_status_file}` via sync-status.js: set `--merge-status "recovered"` for this story.
              **IMPORTANT:** sync-status.js does full block replacement. If the story already has an entry in `{git_status_file}`, re-read its existing fields and pass ALL of them alongside `--merge-status`. If no entry exists yet, pass at minimum `--branch` and `--push-status "pushed"`.
        - If `{{platform}}` is NOT git_only (github, gitlab, bitbucket, gitea) AND `{{create_pr}}` is true:
          - Check if PR/MR already exists for this branch (platform-specific check via create-pr.sh or CLI)
          - If no PR: create one via `node {{project_root}}/_Sprintpilot/scripts/create-pr.js --platform {{platform}} ...`
          - Log: "PR created/found for <story-key>"
          - Update `{git_status_file}` via sync-status.js: set `--merge-status "pr_pending"` for this story (same full-field requirement as above)
    - If status IS "done" AND branch still exists AND `{{cleanup_on_merge}}` is true:
      - Log: "Stale remote branch: <branch> — story already done, cleaning up"
      - Delete remote branch (ignore failure — the branch may already be gone): `git push origin --delete <branch>`
  </action>

  <action>Set `{{git_enabled}}` = true, `{{platform}}` = detected value</action>
</check>

---

<workflow>

<step n="1" goal="Bootstrap: check for saved state or assess project from scratch">

<action>Check if `{state_file}` exists</action>

<check if="state_file EXISTS">
  <action>Read `{state_file}` fully</action>
  <action>Extract saved state:
    - `{{current_story}}` — story in progress when last session ended
    - `{{current_bmad_step}}` — BMAD step that was active (2–7)
    - `{{completed_skill}}` — last skill that ran
    - `{{next_skill}}` — next skill recommended at save time
    - `{{session_stories_done}}` = 0 (reset counter for new session)
    - `{{in_worktree}}` — whether we were in a worktree when session ended
    - `{{pr_base}}` — PR target branch (previous story branch or base_branch)
  </action>
  <action>Read `{status_file}` — note all stories already `done`</action>
  <action>Scan TaskList for orphaned in_progress tasks from the previous session.
  For each task with status `in_progress`:
    - If it is a retrospective task and the retro file already exists → mark `completed`
    - If it is a per-story step task and that story is `done` in `{status_file}` → mark `completed`
    - If it is the master "Sprintpilot" task → leave as `in_progress`
    - Otherwise → leave as `in_progress` and treat as resumption point
  </action>
  <action>Report to user:
  ```
  Sprintpilot ON — Resuming

  Restored from: {state_file}
  Resuming story: {{current_story}}
  Resuming at step: {{current_bmad_step}}
  Next skill: {{next_skill}}
  Git integration: {{git_enabled}}
  ```
  </action>
  <action>**Post-resume reconciliation** — sync state with git reality.
    - Re-read `{status_file}` (may have been updated by boot branch reconciliation)
    - Recalculate `{{stories_remaining}}` by scanning all story keys where status != "done"
    - If `{{current_story}}` is now "done" in `{status_file}` (merged during reconciliation):
      - Log: "Story {{current_story}} was recovered from remote — skipping to next"
      - Set `{{current_story}}` = null
      - Set `{{next_skill}}` = next appropriate skill for first non-done story
    - If `{{next_skill}}` targets a story that is now "done":
      - Advance to next non-done story
    - Update `{state_file}` with reconciled values
  </action>
  <goto step="2">Jump to execution loop with reconciled state</goto>
</check>

<check if="state_file does NOT exist">
  <action>Check if `{status_file}` exists — if not, invoke `bmad-sprint-planning` first</action>

  <check if="{{git_enabled}} AND status_file did not exist (sprint-planning just ran)">
    <action>Run `git fetch origin` to ensure remote refs are current</action>
    <action>Initialize `{git_status_file}` with git_integration block:
    ```yaml
    # Sprintpilot — Git Status
    git_integration:
      enabled: true
      base_branch: {git.base_branch from config}
      platform: {{platform}}

    stories:
    ```
    Note: this is the addon's own file — NEVER write git fields to sprint-status.yaml.
    </action>
  </check>

  <action>Read `{status_file}` — find all stories not yet `done`</action>
  <action>Invoke `bmad-help` — "What is the current project state and next required workflow step?"</action>
  <action>Extract:
    - `{{current_phase}}` — lifecycle phase
    - `{{next_skill}}` — next required skill
    - `{{session_stories_done}}` = 0
  </action>
  <action>Create master task: "Sprintpilot — Full Sprint Execution" → `in_progress`</action>
  <action>Write initial `{state_file}`:
  ```yaml
  last_updated: {current_datetime}
  current_story: null
  current_bmad_step: null
  completed_skill: bmad-help
  next_skill: {{next_skill}}
  session_stories_done: 0
  stories_remaining: [list from sprint-status]
  git_enabled: {{git_enabled}}
  platform: {{platform}}
  in_worktree: false
  pr_base: {{base_branch}}
  ```
  </action>
  <action>Report to user:
  ```
  Sprintpilot ON

  Phase: {{current_phase}}
  First step: {{next_skill}}
  Git integration: {{git_enabled}}
  Platform: {{platform}}
  Session limit: {{session_story_limit}} stories, then checkpoint + new session

  Beginning autonomous execution. I will only stop for true blockers or session checkpoints.
  ```
  </action>
</check>

</step>


<step n="2" goal="Main execution loop — route to correct handler">

<check if="all stories in status_file are done">
  <goto step="10">Sprint complete</goto>
</check>

<check if="{{next_skill}} is empty">
  <action>**Recover next_skill** — re-read `{status_file}`, find first story with status != "done"</action>
  <check if="no undone stories found">
    <goto step="10">Sprint complete</goto>
  </check>
  <action>Set `{{current_story}}` = first undone story from `{status_file}`</action>
  <action>Invoke `bmad-help` — "Story {{current_story}} needs attention. What is the next required workflow step?"</action>
  <action>Extract `{{next_skill}}` from bmad-help response</action>
</check>

<check if="{{next_skill}} is in SKIP list (party-mode, brainstorming)">
  <action>Log: "Skipping {{next_skill}} — interactive-only, not autopilot-compatible"</action>
  <action>Re-read last skill output or invoke `bmad-help` for the next skill after this one</action>
  <action>Update `{{next_skill}}` → loop</action>
  <goto step="2">Re-evaluate</goto>
</check>

<check if="{{next_skill}} is a BLOCKER skill AND its artifact does NOT exist">
  <action>Update `{state_file}`: set `next_skill = {{next_skill}}`</action>
  <action>Report:
  ```
  Autopilot paused — human input required

  Next required step: {{next_skill}}
  This requires your creative input (product vision / business goals)
  that cannot be derived from existing project documents.

  Please complete this step manually, then run /sprint-autopilot-on to resume.
  State saved to: {state_file}
  ```
  </action>
  <action>STOP</action>
</check>

<check if="{{next_skill}} is a BLOCKER skill AND its artifact already exists">
  <action>Log: "Artifact for {{next_skill}} already exists — treating as complete, moving on"</action>
  <action>Re-read last skill output or invoke `bmad-help` for next skill</action>
  <action>Update `{{next_skill}}` → loop</action>
  <goto step="2">Re-evaluate</goto>
</check>

<goto step="3">Execute the skill</goto>

</step>


<step n="3" goal="Prepare and execute the recommended skill">

<action>Set `{{completed_skill}}` = `{{next_skill}}`</action>
<action>Create task "{{next_skill}}" → mark `in_progress`</action>

<check if="{{next_skill}} is a per-story skill (bmad-dev-story, bmad-code-review, bmad-create-story)">
  <action>Set `{{current_story}}` = first story in `{status_file}` with status `ready-for-dev` or `in-progress`</action>

  <critical>**Validate story key format** — the key MUST follow the pattern `{epic}-{story}-{title-kebab}` (e.g., `1-2-user-authentication`), NOT just `{epic}-{story}` (e.g., `1-2`).
  If `{{current_story}}` matches only `^\d+-\d+$` (numeric only, no title):
  - Find the story file in `{implementation_artifacts}` matching `{{current_story}}-*.md` or `story-{{current_story}}*.md`
  - If found: extract the full kebab-case name from the filename and update `{{current_story}}`
  - If not found: read the epics file, find the matching story title, convert to kebab-case, and update `{{current_story}}`
  - Update `{{current_story}}` variable to use the full name (do NOT modify sprint-status.yaml — it is BMAD-owned)
  A short key like `1-1` produces branches named `story/1-1` and PRs with no description — the title is essential for human-readable git history.</critical>

  <action>Create per-story step tasks if not already created</action>
</check>

<!-- GIT: Enter worktree before dev-story -->
<check if="{{git_enabled}} AND {{next_skill}} is bmad-dev-story">
  <action>**Sanitize branch name** — run:
  `node {{project_root}}/_Sprintpilot/scripts/sanitize-branch.js "{{current_story}}" --prefix "{{branch_prefix}}" --max-length 60`
  Output: sanitized name (without prefix). Set `{{branch_name}}` = output.
  Full branch ref will be `{{branch_prefix}}{{branch_name}}`.
  </action>

  <action>**Check if branch already registered** in `{status_file}` for this story.
  If yes AND worktree already exists → skip creation (idempotent).
  If yes AND no worktree → recovery mode (see health check).
  If no → proceed with creation.
  </action>

  <action>**Prepare for worktree** — determine the correct branch point.
  Run: `git fetch origin`

  Check if there is a previous story in this epic with a pushed but unmerged branch (PR pending):
  - Read `{git_status_file}` for earlier stories in the same epic
  - Find the latest story branch where `push_status` = "pushed" AND `pr_url` is a valid URL
  - Check if that branch has been merged to `{{base_branch}}`: `git merge-base --is-ancestor origin/{{branch_prefix}}<prev-branch> origin/{{base_branch}}`

  If an unmerged previous story branch exists:
  - Branch from it: `git checkout origin/{{branch_prefix}}<prev-branch>`
  - Set `{{pr_base}}` = `{{branch_prefix}}<prev-branch>` (PR should target previous story, not main)
  - Log: "Branching from {{branch_prefix}}<prev-branch> (PR pending merge)"
  Otherwise:
  - Branch from base: `git checkout origin/{{base_branch}}`
  - Set `{{pr_base}}` = `{{base_branch}}`

  (Detached HEAD is fine — the worktree add below creates a new branch from HEAD)
  </action>

  <action>**Create worktree** using standard git commands (works in any coding agent):
  ```
  git worktree add "{{project_root}}/.worktrees/{{current_story}}" -b "{{branch_prefix}}{{branch_name}}" 2>&1
  ```
  This creates `.worktrees/{{current_story}}/` with a new branch `{{branch_prefix}}{{branch_name}}` from HEAD.

  If worktree add fails (branch already exists):
  ```
  git worktree add "{{project_root}}/.worktrees/{{current_story}}" "{{branch_prefix}}{{branch_name}}" 2>&1
  ```

  **If both fail** (disk full, permissions, etc.):
  - Log: "WARN: git worktree add failed — continuing without worktree isolation"
  - Set `{{in_worktree}}` = false
  - Create branch manually: `git checkout -b {{branch_prefix}}{{branch_name}}`
    If checkout also fails (branch already exists): `git checkout {{branch_prefix}}{{branch_name}}`
    If both fail: HALT — "Could not create or switch to branch {{branch_prefix}}{{branch_name}}"
  - Continue with the skill invocation in PROJECT_ROOT (no isolation)
  - Git operations (commit, push, PR) still work on the branch
  </action>

  <check if="worktree add succeeded">
    <action>**Change working directory** to the worktree:
    `cd {{project_root}}/.worktrees/{{current_story}}`
    All subsequent file operations and commands MUST use this directory.
    Set `{{worktree_path}}` = `{{project_root}}/.worktrees/{{current_story}}`
    </action>

    <action>**Init submodules** if needed.
    First check for `.gitmodules` (use your file-exists tool, or `node -e "process.exit(require('fs').existsSync('.gitmodules')?0:1)"`). If not present, skip this step.
    If present, run `git submodule update --init --recursive` (give it ~30 seconds). If the command fails or hangs, warn "Submodule init failed (may need auth). Continuing without." and proceed.
    </action>

    <action>Set `{{in_worktree}}` = true</action>
  </check>
  <action>Update `{state_file}` (write to worktree copy since we're now IN the worktree)</action>
</check>

<action>Update `{state_file}`:
```yaml
last_updated: {current_datetime}
current_story: {{current_story}}
current_bmad_step: executing
completed_skill: {previous skill}
next_skill: {{next_skill}}
session_stories_done: {{session_stories_done}}
stories_remaining: {{stories_remaining}}
git_enabled: {{git_enabled}}
platform: {{platform}}
in_worktree: {{in_worktree}}
pr_base: {{pr_base}}
```
</action>

<!-- Autopilot menu handling rules apply — see AUTOPILOT RULES section above -->

<action>INVOKE `{{next_skill}}` skill using the Skill tool</action>
<action>Mark task "{{next_skill}}" as `completed`</action>

<goto step="4">Handle completion</goto>

</step>


<step n="4" goal="Handle skill completion and route to next action">

<check if="{{completed_skill}} was bmad-dev-story">
  <action>Verify tests ran — if not, run them now: report `N/N passed`</action>
  <action>**Log decisions** — review implementation choices made during dev-story and append entries to `{decision_log_file}` for any architecture, test-strategy, dependency, scope, or workaround decisions (see DECISION LOGGING section)</action>

  <!-- GIT: Lint, stage, and commit after dev-story -->
  <check if="{{git_enabled}} AND {{in_worktree}}">
    <action>**Lint changed files** — run:
    `node {{project_root}}/_Sprintpilot/scripts/lint-changed.js --limit 100 --output-file lint-output.txt`
    Log the output summary (non-blocking — lint never halts the autopilot).
    Set `{{lint_result}}` from the summary line.
    </action>

    <action>**Stage and commit** — resolve commit message placeholders using `commit_placeholder_resolution` chain from config:
    - `{story-key}` → from sprint-status.yaml development_status key (= `{{current_story}}`)
    - `{epic}` → from story file epic header, fallback to story-key prefix (e.g., "1" from "1-3")
    - `{story-title}` → from story file title, fallback to story-key
    - `{patch-title}` → from review finding title, fallback to "code review fix"
    Read the commit template from `git.commit_templates.story` in config (default: `feat({epic}): {story-title} ({story-key})`).
    Then run:
    `node {{project_root}}/_Sprintpilot/scripts/stage-and-commit.js --message "feat({{epic}}): {{story-title}} ({{current_story}})" --allowlist {{project_root}}/_Sprintpilot/.secrets-allowlist`
    Output: commit SHA. Set `{{story_commit}}` = output.
    Warnings (secrets, large files) printed to stderr — review but don't halt unless user says to.
    </action>

  </check>

  <action>Set `{{next_skill}}` = `bmad-code-review` (mandatory after dev-story)</action>
  <goto step="8">Save state and continue</goto>
</check>

<check if="{{completed_skill}} was bmad-code-review">
  <check if="patch findings exist">
    <action>Set `{{next_skill}}` = `apply-patches` (internal step 6)</action>
    <goto step="6">Apply patches</goto>
  </check>
  <goto step="7">Mark story done</goto>
</check>

<check if="{{completed_skill}} was bmad-retrospective">
  <action>Log: "Epic retrospective complete — BMAD skills will update sprint-status.yaml directly"</action>
</check>

<check if="{{completed_skill}} was bmad-create-epics-and-stories">
  <action>**Validate BDD acceptance criteria** — find the epics file in `{planning_artifacts}` (glob for `*epic*.md`).
  For each story section, check that acceptance criteria contain **Given**, **When**, and **Then** keywords.
  If any story lacks BDD format:
  - Rewrite only the acceptance criteria lines in Given/When/Then format, preserving all other content
  - After rewriting, re-read the file and verify: heading structure intact, all stories still present, Given/When/Then present in every story
  - Log: "Fixed N stories with non-BDD acceptance criteria"
  </action>
</check>

<check if="{{completed_skill}} was bmad-sprint-planning AND {{git_enabled}}">
  <action>Run `git fetch origin`</action>
  <action>Initialize `{git_status_file}` if it doesn't exist (with git_integration block)</action>
</check>

<check if="{{completed_skill}} was bmad-create-story">
  <action>Verify story file has `- [ ]` checkboxes in Tasks/Subtasks section. If missing, re-run create-story.</action>
</check>

<check if="{{completed_skill}} was bmad-create-story AND {{git_enabled}}">
  <action>Sanitize branch name for `{{current_story}}` (same logic as step 3)</action>
  <action>Check if branch already registered in `{git_status_file}` for this story → skip if so</action>
  <action>Register branch in `{git_status_file}`:
  `node {{project_root}}/_Sprintpilot/scripts/sync-status.js --story "{{current_story}}" --git-status-file "{{project_root}}/_bmad-output/implementation-artifacts/git-status.yaml" --branch "{{branch_prefix}}{{branch_name}}" --platform "{{platform}}" --base-branch "{{base_branch}}"`
  </action>
</check>

<!-- GIT: Commit planning artifacts to main after planning skills -->
<check if="{{git_enabled}} AND {{completed_skill}} is a planning skill (bmad-create-prd, bmad-create-architecture, bmad-create-ux-design, bmad-create-epics-and-stories, bmad-sprint-planning, bmad-check-implementation-readiness, bmad-create-story)">
  <action>**Commit planning artifacts to main** — keep track of all planning decisions in git.
  Stage all changed artifacts (ignore errors — any of these paths may not yet exist):
  ```
  git add _bmad-output/planning-artifacts/ _bmad-output/implementation-artifacts/ _bmad-output/stories/
  ```
  Check if there's anything staged; if yes, commit:
  ```
  git diff --cached --quiet
  ```
  If that exits non-zero (there are staged changes), run: `git commit -m "docs: {{completed_skill}} artifacts"`
  Then push (log a warning if push fails; do not halt autopilot):
  ```
  git push origin {{base_branch}}
  ```
  </action>
</check>

<goto step="5">Read skill output for next step</goto>

</step>


<step n="5" goal="Determine next skill — from skill output first, bmad-help as fallback">

<action>Read the output of `{{completed_skill}}`</action>

<check if="output contains 'Next Steps', 'What to do next', 'Run next', or equivalent">
  <action>Extract `{{next_skill}}` from that section</action>
  <action>Log: "Next step from skill output: {{next_skill}}"</action>
</check>

<check if="output contains NO clear next step">
  <action>Invoke `bmad-help` — "{{completed_skill}} just finished. What is the next required workflow step?"</action>
  <action>Extract `{{next_skill}}` from bmad-help response</action>
  <action>Log: "Next step from bmad-help fallback: {{next_skill}}"</action>
</check>

<check if="{{next_skill}} is null, empty, or signals completion (no further steps / sprint done / all done)">
  <action>**Verify against source of truth** — re-read `{status_file}` and check for any story with status != "done"</action>
  <check if="undone stories exist in status_file">
    <action>Set `{{current_story}}` = first undone story from `{status_file}`</action>
    <action>Determine `{{next_skill}}` based on that story's current status and BMAD step:
      - If story has no story file yet → `bmad-create-story`
      - If story file exists but status is `ready-for-dev` → `bmad-check-implementation-readiness`
      - If story is `in-progress` and `current_bmad_step` is before `code-review` (i.e. RED or GREEN phase) → `bmad-dev-story`
      - If story is `in-progress` and `current_bmad_step` is `code-review` or later → `bmad-code-review`
      - Otherwise → invoke `bmad-help` for precise determination
    </action>
    <action>Log: "next_skill was empty but undone stories remain — resolved to {{next_skill}} for {{current_story}}"</action>
  </check>
  <check if="all stories in status_file are done">
    <goto step="10">Sprint complete</goto>
  </check>
</check>

<goto step="8">Save state and continue</goto>

</step>


<step n="6" goal="Apply all patch findings automatically">

<action>Mark task "[story] Apply patches" → `in_progress`</action>

<critical>
Apply ALL patch and bugfix findings automatically. For each:
1. Create sub-task "Patch: [title]" → `in_progress`
2. Apply fix
3. Run affected tests — report `N/N passed`
4. **Log decision** — append `review-accept` entry to `{decision_log_file}` with finding title and rationale
5. If {{git_enabled}} AND {{in_worktree}}:
   - Stage changed files explicitly: `git add -- "file1" "file2"`
   - Commit: `git commit -m "fix({{current_story}}): {{patch_title}}"`
   - Record commit SHA in `{{patch_commits}}` list
6. Mark sub-task `completed`

For any finding that is DISMISSED (contradicts AC or is a false positive):
- **Log decision** — append `review-triage` entry to `{decision_log_file}` with finding title, why it was dismissed, and impact level
</critical>

<action>Run full test suite after all patches — report `N/N passed`</action>

<check if="any test fails after patching">
  <action>Increment failure counter</action>
  <check if="failure_counter >= 3 with no progress">
    <action>Update `{state_file}`</action>
    <action>PAUSE: "3 consecutive patch failures on {{current_story}}. Need guidance."</action>
    <action>STOP</action>
  </check>
  <action>Diagnose and fix — re-run — loop until green</action>
  <action>**Log decision** — append `halt-recovery` entry to `{decision_log_file}` with root cause and resolution</action>
</check>

<action>Log: "All patches applied — {{N}}/{{N}} passing"</action>
<action>Mark "[story] Apply patches" → `completed`</action>

<!-- Re-run code review to sync sprint-status.yaml — patches resolved all findings, so code-review will now set story to done -->
<action>Re-invoke `bmad-code-review` using the Skill tool.
The review layers already ran — this pass will see zero unresolved findings and set the story status to `done` in sprint-status.yaml (code-review owns that transition per step-04-present.md:92).
Instruct: "Re-verify code review for story {{current_story}} — all patch findings have been applied. Update story status accordingly."
</action>
<action>Mark task "code-review-verify" → `completed`</action>

<goto step="7">Mark story done</goto>

</step>


<step n="7" goal="Mark story done, git push/PR, update records, check epic completion">

<action>**Mark all task checkboxes complete** in the story file:
  - Find every `- [ ]` in the Tasks / Subtasks section and replace with `- [x]`
  - Verify zero `- [ ]` remain in the story file
</action>

<action>Fill story file Dev Agent Record:
  - Files changed
  - Autonomous decisions made
  - Final test count: `N/N passed`
</action>

<!-- GIT: Push, PR, exit worktree -->
<check if="{{git_enabled}} AND {{in_worktree}}">
  <check if="{{push_auto}} is true">
    <action>**Push branch**.
    Run: `git push -u origin {{branch_prefix}}{{branch_name}} 2>&1`
    If push fails → set `{{push_status}}` = "failed", log warning, continue.
    If push succeeds → set `{{push_status}}` = "pushed".
    </action>
  </check>
  <check if="{{push_auto}} is false">
    <action>Set `{{push_status}}` = "local", `{{pr_url}}` = "SKIPPED"</action>
    <action>Log: "Push skipped (git.push.auto = false). Branch {{branch_prefix}}{{branch_name}} is local only."</action>
  </check>

  <action>**Create PR/MR** (if push succeeded AND `{{create_pr}}` is true AND platform != git_only):
  If `{{create_pr}}` is false OR `{{push_status}}` is not "pushed" → set `{{pr_url}}` = "SKIPPED", skip PR creation.
  1. Read PR body template: `{{project_root}}/_Sprintpilot/{{pr_template}}`
     If template file doesn't exist at that path, use a simple default: "## Story: {{current_story}}\n\n{{story-title}}"
  2. Fill template placeholders using the `commit_placeholder_resolution` chain from config:
     - `{story-key}` → `{{current_story}}` (from sprint-status)
     - `{story-title}` → from story file title, fallback to story-key
     - `{epic}` → from story file epic header, fallback to story-key prefix
     - `{change-summary}` → list of changed files from `git diff --stat`
     - `{acceptance-criteria}` → from story file AC section
     - `{lint-result}` → `{{lint_result}}`
     - `{test-result}` → from last test run output
     - `{patch-count}` → number of patch commits
  3. Run: `node {{project_root}}/_Sprintpilot/scripts/create-pr.js --platform {{platform}} --branch {{branch_prefix}}{{branch_name}} --base {{pr_base}} --title "{{story-title}} ({{current_story}})" --body "<filled template>"`
  4. Output: PR URL or "SKIPPED". Set `{{pr_url}}` = output.
  If creation fails → log warning, set `{{pr_url}}` = null, continue.
  </action>

  <action>**Exit worktree** — change working directory back to project root:
  `cd {{project_root}}`
  All subsequent commands now run from the project root.
  Set `{{in_worktree}}` = false.
  </action>

  <check if="{{create_pr}} is false OR {{platform}} is git_only OR {{pr_url}} is null or SKIPPED">
    <action>**Merge story branch to main** — tracked and retryable.
    Run:
    ```
    git checkout -B {{base_branch}} origin/{{base_branch}}
    git merge {{branch_prefix}}{{branch_name}} --no-edit
    ```
    If succeeds:
      - `git push origin {{base_branch}}`
      - Set `{{merge_status}}` = "merged"
    If fails (conflict):
      - `git merge --abort`
      - `git fetch origin`
      - `git checkout -B {{base_branch}} origin/{{base_branch}}`
      - Retry merge once: `git merge {{branch_prefix}}{{branch_name}} --no-edit`
      - If retry succeeds: push, set `{{merge_status}}` = "merged"
      - If retry fails: set `{{merge_status}}` = "failed"
        Log: "WARN: merge failed for {{current_story}} — will retry on next boot"

    If `{{merge_status}}` == "failed":
      Log warning but do NOT halt. The branch is pushed and preserved.
      Boot reconciliation (INITIALIZATION branch reconciliation) will retry on next session.

    Note: `{{merge_status}}` is persisted by the full sync-status.js call later in this step (via `--merge-status`). Do NOT call sync-status.js separately here — it does full block replacement and would destroy other fields.
    </action>
    <check if="{{cleanup_on_merge}} is true">
      <action>**Cleanup worktree** for merged story — branch was merged locally, worktree is no longer needed. Ignore failures from the remove (the worktree may already be gone):
      ```
      git worktree remove .worktrees/{{current_story}} --force
      git worktree prune
      ```
      </action>
    </check>
  </check>
  <check if="{{pr_url}} is a valid URL (not null, not SKIPPED)">
    <critical>**DO NOT merge** — a PR was created at {{pr_url}}. Merging requires PR approval. The branch will be merged through the PR workflow on the platform.</critical>
    <action>Set `{{merge_status}}` = "pr_pending"</action>
    <action>Log: "Story {{current_story}} pushed — PR awaiting review: {{pr_url}}"</action>
  </check>

  <!-- Commit all implementation artifacts and status updates to main after each story -->
  <action>**Commit story completion artifacts to main** — ensure main always reflects current sprint state.
  ```
  git checkout -B {{base_branch}} origin/{{base_branch}}
  ```
  </action>

  <action>**Write git status** to addon's own file (NEVER modify sprint-status.yaml) — runs AFTER checkout to base branch so the file persists in the working tree for the commit below:
  `node {{project_root}}/_Sprintpilot/scripts/sync-status.js --story "{{current_story}}" --git-status-file "{{project_root}}/_bmad-output/implementation-artifacts/git-status.yaml" --branch "{{branch_prefix}}{{branch_name}}" --commit "{{story_commit}}" --patch-commits "{{patch_commits_csv}}" --push-status "{{push_status}}" --merge-status "{{merge_status}}" --pr-url "{{pr_url}}" --lint-result "{{lint_result}}" --worktree "{{project_root}}/.worktrees/{{current_story}}" --platform "{{platform}}" --base-branch "{{base_branch}}"`
  This writes to `git-status.yaml` (addon-owned). Sprint-status.yaml is BMAD-owned — updated by BMAD skills only.
  </action>

  <action>**Stage and commit artifacts** — explicitly include git-status.yaml and decision-log.yaml. Ignore errors from the `git add` (any listed path may not yet exist):
  ```
  git add _bmad-output/implementation-artifacts/sprint-status.yaml _bmad-output/implementation-artifacts/git-status.yaml _bmad-output/implementation-artifacts/autopilot-state.yaml _bmad-output/implementation-artifacts/decision-log.yaml _bmad-output/stories/ _bmad-output/planning-artifacts/
  ```
  Check if anything is staged: `git diff --cached --quiet`. If that exits non-zero, commit:
  `git commit -m "docs: story {{current_story}} done — {{test_count}} tests{{#if pr_url}}, PR: {{pr_url}}{{/if}}"`
  Then push (log a warning if push fails; do not halt autopilot):
  ```
  git push origin {{base_branch}}
  ```
  This ensures sprint-status.yaml, git-status.yaml, story files, and any updated artifacts are on main even when story code is on a PR branch.
  </action>
</check>

<!-- Story git status was already written by sync-status.js above (when git_enabled AND in_worktree).
     sprint-status.yaml is BMAD-owned — updated by bmad-dev-story / bmad-code-review directly. -->
<check if="NOT {{git_enabled}}">
  <action>Log: "Story {{current_story}} complete — BMAD dev-story updates sprint-status.yaml directly"</action>
</check>

<action>Mark all remaining tasks for this story → `completed`</action>
<action>**Increment `{{session_stories_done}}` by 1** — this is the ONLY place the counter ticks up. It runs only after the story's full implementation cycle (dev-story GREEN + code-review + patches + artifacts committed + optional push/PR). Creating a story file in step 3 never increments this counter.</action>
<action>Remove `{{current_story}}` from `{{stories_remaining}}` list</action>

<action>Report: "Story {{current_story}} done — N/N passing{{#if pr_url}} — PR: {{pr_url}}{{/if}}"</action>

<action>Check if ALL stories in this epic are `done`</action>
<check if="epic complete">
  <action>Create task "[epic] retrospective" → `in_progress`</action>
  <action>INVOKE `bmad-retrospective` using Skill tool (retrospective skill updates sprint-status.yaml itself)</action>
  <action>Mark retrospective task → `completed`</action>
  <action>Set `{{completed_skill}}` = `bmad-retrospective`</action>

  <!-- GIT: Epic completion — suggest merge, cleanup worktrees -->
  <check if="{{git_enabled}}">
    <action>**List all epic PR/MR URLs** from `{status_file}` for this epic's stories</action>
    <action>Report:
    ```
    Epic complete — PR/MR summary:
    {{#each epic_stories}}
    - {{story-key}}: {{pr_url}}
    {{/each}}

    Ready to merge. Review PRs and confirm when ready.
    ```
    </action>
    <check if="{{cleanup_on_merge}} is true">
      <action>**Cleanup worktrees** for completed stories:
      For each story in this epic:
        1. Check if worktree at `.worktrees/{{story-key}}` exists
        2. Check if clean: `git -C .worktrees/{{story-key}} status --porcelain`
        3. If clean → `git worktree remove .worktrees/{{story-key}}` + `git worktree prune`
           Update `{git_status_file}` for this story: `worktree_cleaned: true`
        4. If dirty → warn user, skip cleanup
      </action>
    </check>
    <check if="{{cleanup_on_merge}} is false">
      <action>Log: "Worktree cleanup skipped (git.worktree.cleanup_on_merge = false)"</action>
    </check>
  </check>
</check>

<!-- Session limit check — 0 means disabled (run until sprint complete) -->
<check if="{{session_story_limit}} > 0 AND {{session_stories_done}} >= {{session_story_limit}}">
  <goto step="9">Session checkpoint</goto>
</check>

<goto step="5">Determine next skill</goto>

</step>


<step n="8" goal="Save state and continue">

<action>Update `{state_file}`:
```yaml
last_updated: {current_datetime}
current_story: {{current_story}}
current_bmad_step: {{current_bmad_step}}
completed_skill: {{completed_skill}}
next_skill: {{next_skill}}
session_stories_done: {{session_stories_done}}
stories_remaining: {{stories_remaining}}
git_enabled: {{git_enabled}}
platform: {{platform}}
in_worktree: {{in_worktree}}
pr_base: {{pr_base}}
```
</action>

<goto step="2">Continue execution loop</goto>

</step>


<step n="9" goal="Session checkpoint — proactive handoff before compaction">

<!-- GIT: Exit worktree if we're in one before checkpointing -->
<check if="{{in_worktree}}">
  <action>Commit any uncommitted work in the worktree first</action>
  <action>`cd {{project_root}}` — return to project root, preserve worktree for next session</action>
  <action>Write git status to git-status.yaml (same sync as step 7)</action>
  <action>Set `{{in_worktree}}` = false</action>
</check>

<check if="{{git_enabled}}">
  <action>**Pre-checkpoint merge sweep** — ensure all completed stories are on base branch.
  Read `{git_status_file}`. For each story completed this session:
    - If merge_status is "merged" or "pr_pending": skip
    - If merge_status is "pending", empty, or "failed":
      - Determine branch ref: if push_status is "pushed", use `origin/{{branch_prefix}}<branch>`;
        if push_status is "local", use local ref `{{branch_prefix}}<branch>`
      - Attempt merge:
        `git checkout -B {{base_branch}} origin/{{base_branch}}`
        `git merge <branch-ref> --no-edit`
        `git push origin {{base_branch}}`
      - If merge succeeds: update merge_status in `{git_status_file}`.
        **IMPORTANT:** sync-status.js does full block replacement — you MUST re-read the story's existing fields from `{git_status_file}` (branch, commit, patch_commits, push_status, pr_url, lint_result, worktree, platform, base_branch, worktree_cleaned) and pass ALL of them along with `--merge-status "merged"`. Omitting fields destroys them.
      - If merge fails: `git merge --abort`, update merge_status to "failed" in `{git_status_file}` (same full-field requirement), log warning, continue
  Log: "Pre-checkpoint merge: N stories verified on {{base_branch}}"
  </action>
</check>

<action>Update `{state_file}`:
```yaml
last_updated: {current_datetime}
current_story: {{current_story}}
current_bmad_step: {{current_bmad_step}}
completed_skill: {{completed_skill}}
next_skill: {{next_skill}}
session_stories_done: {{session_stories_done}}
stories_remaining: {{stories_remaining}}
git_enabled: {{git_enabled}}
platform: {{platform}}
in_worktree: {{in_worktree}}
pr_base: {{pr_base}}
```
</action>

<action>Read `{decision_log_file}` — count medium/high decisions from this session's stories</action>

<action>Report to user:
```
Autopilot session checkpoint

Completed {{session_stories_done}} stories this session.
State fully saved to: {state_file}
{{#if git_enabled}}
Git status:
{{#each completed_stories_this_session}}
  - {{story-key}}: {{push_status}} {{pr_url}}
{{/each}}
{{/if}}
{{#if medium_high_decisions_count > 0}}

Decisions requiring review: {{medium_high_decisions_count}} (medium/high impact)
{{#each medium_high_decisions}}
  #{{id}} [{{impact}}] {{story}} — {{decision}}
{{/each}}
Full log: {decision_log_file}
{{/if}}

To continue without losing any context, please start a new session and run:
  /sprint-autopilot-on

Autopilot will resume exactly from: {{next_skill}} on {{current_story}}
No work will be repeated.
```
</action>

<action>STOP — wait for user to start a new session</action>

</step>


<step n="10" goal="Sprint complete — emit summary and next steps">

<!-- GIT: Exit worktree if still in one -->
<check if="{{in_worktree}}">
  <action>`cd {{project_root}}` — return to project root</action>
  <action>Set `{{in_worktree}}` = false</action>
</check>

<action>Verify: all stories `done`, all retrospectives `done` in `{status_file}`</action>
<action>Run full test suite — report `N/N passed`</action>

<!-- Generate project documentation after sprint completion -->
<action>**Generate documentation** — create or update project README and docs.
Invoke `bmad-document-project` skill to auto-generate documentation from the completed implementation.
If the skill is not available or fails, generate a minimal README.md:
- Project name and description (from product brief / PRD)
- How to install (`npm install` / `pip install` / etc.)
- How to run (`npm start` / the launch command)
- How to test (`npm test`)
- Architecture overview (from architecture doc if it exists)
</action>

<!-- GIT: Commit documentation and final artifacts to main -->
<check if="{{git_enabled}}">
  <action>**Commit final artifacts and documentation to main**. Run each step; if an early step fails, STOP and log — don't proceed past a failed step. `git add` may fail for missing optional paths (`docs/`, `README.md`); ignore those path-specific errors. Failure of the final push should log a warning but not halt autopilot:
  ```
  git checkout -B {{base_branch}} origin/{{base_branch}}
  git add _bmad-output/ README.md docs/
  ```
  Check if anything is staged: `git diff --cached --quiet`. If that exits non-zero, commit:
  `git commit -m "docs: project documentation and final artifacts"`
  Then: `git push origin {{base_branch}}`
  </action>
</check>

<action>Read `{status_file}` and collect:
  - All completed stories grouped by epic, with their story titles
  - Total story count, total epic count
  - Final test count
  - If git_enabled: all PR/MR URLs, patch counts, dismissed findings per story
</action>

<action>Read `{decision_log_file}` and collect:
  - All decisions with impact `medium` or `high`
  - Count of `review-accept` entries (patches applied)
  - Count of `review-triage` entries (findings dismissed)
  - Total review rounds (count of code-review invocations)
  - Per-story summary: patches applied and findings dismissed
</action>

<action>Find the app launch command by checking (in order):
  1. `run_gui.sh` or `run.sh` in the project root
  2. `main.py` in the project root
  3. Check `pyproject.toml`, `package.json`, or `setup.py` for scripts
  Record as `{{launch_cmd}}`
</action>

<!-- GIT: Final worktree cleanup — safety net for any worktrees not cleaned during epic completion -->
<check if="{{git_enabled}}">
  <action>**Cleanup all remaining worktrees**:
  Run: `git worktree list --porcelain`
  For each worktree that is NOT the main worktree, run the following — log and continue on failure; some worktrees may already be gone:
    `git worktree remove <path> --force`
  Then: `git worktree prune`
  </action>
</check>

<!-- GIT: Release lock -->
<check if="{{git_enabled}}">
  <action>Release lock: `node {{project_root}}/_Sprintpilot/scripts/lock.js release`</action>
</check>

<action>Delete `{state_file}` — sprint complete</action>
<action>Mark master task "Sprintpilot — Full Sprint Execution" → `completed`</action>

<action>Report (use exact format):
```
╔═══════════════════════════════════════════════════════════════╗
║                   BMAD AUTOPILOT — REPORT                     ║
╚═══════════════════════════════════════════════════════════════╝

SUMMARY
  Stories completed : {{done_count}}/{{total_stories}}
  Epics completed   : {{done_epics}}/{{total_epics}}
  Total tests       : {{N}}/{{N}} passed
{{#if git_enabled}}
  Platform          : {{platform}}
{{/if}}

STORIES
{{#each epic}}
  Epic {{epic_number}}: {{epic_title}}
  {{#each stories}}
  ✓ {{story-key}}  — {{test_count}} tests{{#if pr_url}}  PR: {{pr_url}}{{/if}}
  {{/each}}
{{/each}}
{{#if remaining_stories}}
  Not started:
  {{#each remaining_stories}}
  · {{story-key}}
  {{/each}}
{{/if}}

DECISIONS REQUIRING REVIEW (high/medium impact)
{{#each medium_high_decisions}}
  #{{id}}  [{{impact}}] {{story}} / {{phase}}
      {{decision}}
      → {{rationale}}
{{/each}}
{{#if no_medium_high_decisions}}
  None — all decisions were low-impact.
{{/if}}

  Full log: {decision_log_file}

REVIEW FINDINGS APPLIED
  Patches applied    : {{total_patches}}
  Findings dismissed : {{total_dismissed}}
  Review rounds      : {{total_review_rounds}}

CODE REVIEW SUMMARY (per story)
{{#each completed_stories}}
  {{story-key}} : {{patches_applied}} patches applied, {{findings_dismissed}} dismissed
{{/each}}

WHAT TO DO NEXT
  1. Review decisions marked medium/high above
{{#if has_pr_urls}}
  2. Merge open PRs: {{pr_urls_list}}
{{/if}}
{{#if launch_cmd}}
  {{next_number}}. Run the app: {{launch_cmd}}
{{/if}}
  {{next_number}}. Manual smoke test checklist:
{{#each completed_stories}}
     · [{{story-key}}] {{smoke_test_suggestion}}
{{/each}}
```
</action>

</step>

</workflow>
