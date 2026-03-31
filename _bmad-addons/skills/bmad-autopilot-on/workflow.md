# BMAD Autopilot — ON (Enhanced with Git Workflow)

## Purpose

You are now in **BMAD Autopilot Mode** with **git workflow integration**. Drive the project from its current state all the way to a working, tested, reviewed application — following BMAD's own workflow guidance at every step, with automatic git branching, commits, and PR creation.

You do NOT hardcode the workflow sequence. After each completed skill, read its output for a "next steps" recommendation and follow that. Only when no clear next step is in the output do you consult `bmad-help`. BMAD's own output is the primary oracle; `bmad-help` is the fallback.

**Git integration** is additive. If `_bmad-addons/manifest.yaml` doesn't exist or `git.enabled: false`, all git operations are silently skipped and this workflow behaves identically to the stock autopilot.

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
- **Proactive session handoff.** After completing `{{session_story_limit}}` stories in one session (default: 3), write state and tell user to start a new session with `/bmad-autopilot-on`. Do not wait for compaction to happen.
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
- `session_story_limit` = 3
- `project_root` = absolute path of current working directory (store for later use)

### Git integration bootstrap

<action>Check if `{project-root}/_bmad-addons/manifest.yaml` exists</action>

<check if="manifest exists">
  <action>Read `{project-root}/_bmad-addons/manifest.yaml`</action>
  <action>Read `{project-root}/_bmad-addons/modules/git/config.yaml`</action>
  <action>Set config variables from `git.*` fields (defaults in parentheses):
  - `{{git_enabled}}` from `git.enabled` (true)
  - `{{base_branch}}` from `git.base_branch` (main)
  - `{{branch_prefix}}` from `git.branch_prefix` ("story/")
  - `{{push_auto}}` from `git.push.auto` (true)
  - `{{create_pr}}` from `git.push.create_pr` (true)
  - `{{pr_template}}` from `git.push.pr_template` ("modules/git/templates/pr-body.md")
  - `{{cleanup_on_merge}}` from `git.worktree.cleanup_on_merge` (true)
  </action>
</check>

<check if="manifest does NOT exist">
  <action>Set `{{git_enabled}}` = false</action>
  <action>Log: "No _bmad-addons/manifest.yaml found — running stock autopilot (no git)"</action>
</check>

<check if="{{git_enabled}} is true">
  <action>Verify git repo: run `git rev-parse --git-dir`</action>
  <check if="not a git repo">
    <action>HALT: "No git repository found. Initialize one first:
    ```
    git init && git add -A && git commit -m 'initial commit'
    git remote add origin <your-repo-url>
    ```
    Then run /bmad-autopilot-on again."</action>
    <action>STOP</action>
  </check>

  <action>**Lock file** — run: `bash {{project_root}}/_bmad-addons/scripts/lock.sh acquire`
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
  `bash {{project_root}}/_bmad-addons/scripts/detect-platform.sh --provider {{git.platform.provider}}`
  Output: `github`, `gitlab`, or `git_only`. Set `{{platform}}` to the output.
  Log: "Platform detected: {{platform}}"
  </action>

  <action>**Worktree health check** — run:
  `bash {{project_root}}/_bmad-addons/scripts/health-check.sh --base-branch {{base_branch}} --status-file {{status_file}}`
  Output classifies each worktree as CLEAN_DONE, COMMITTED, STALE, DIRTY, or ORPHAN.
  - CLEAN_DONE: `git worktree remove .claude/worktrees/<name>` + `git worktree prune`
  - COMMITTED: log "Recoverable work found for <name> — will push via git -C"
    Push the branch: `git -C .claude/worktrees/<name> push -u origin <branch> 2>&1`
    If `{{create_pr}}` is true AND platform != git_only: create PR via `bash {{project_root}}/_bmad-addons/scripts/create-pr.sh ...`
    If `{{create_pr}}` is false OR platform is git_only: merge directly — `git checkout -B {{base_branch}} origin/{{base_branch}} && git merge <branch> --no-edit && git push origin {{base_branch}}`
    Then remove worktree.
  - STALE: `git worktree remove .claude/worktrees/<name> --force` + prune
  - DIRTY: warn user, ask how to proceed (stash/commit/discard)
  - ORPHAN: `rm -rf .claude/worktrees/<name>` + `git worktree prune`
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
    - If it is the master "BMAD Autopilot" task → leave as `in_progress`
    - Otherwise → leave as `in_progress` and treat as resumption point
  </action>
  <action>Report to user:
  ```
  BMAD Autopilot ON — Resuming

  Restored from: {state_file}
  Resuming story: {{current_story}}
  Resuming at step: {{current_bmad_step}}
  Next skill: {{next_skill}}
  Git integration: {{git_enabled}}
  ```
  </action>
  <goto step="2">Jump to execution loop with restored state</goto>
</check>

<check if="state_file does NOT exist">
  <action>Check if `{status_file}` exists — if not, invoke `bmad-sprint-planning` first</action>

  <check if="{{git_enabled}} AND status_file did not exist (sprint-planning just ran)">
    <action>Run `git fetch origin` to ensure remote refs are current</action>
    <action>Initialize `{git_status_file}` with git_integration block:
    ```yaml
    # BMAD Autopilot Add-On — Git Status
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
  <action>Create master task: "BMAD Autopilot — Full Sprint Execution" → `in_progress`</action>
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
  BMAD Autopilot ON

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

<check if="{{next_skill}} is empty OR all stories in status_file are done">
  <goto step="10">Sprint complete</goto>
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

  Please complete this step manually, then run /bmad-autopilot-on to resume.
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
  `bash {{project_root}}/_bmad-addons/scripts/sanitize-branch.sh "{{current_story}}" --prefix "{{branch_prefix}}" --max-length 60`
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

  (Detached HEAD is fine — EnterWorktree branches from HEAD)
  </action>

  <action>**Enter worktree** using the EnterWorktree tool:
  `EnterWorktree(name: "{{current_story}}")`
  This creates `.claude/worktrees/{{current_story}}` with a new branch from HEAD.
  ALL subsequent tool calls now operate in this worktree directory.

  **If EnterWorktree fails** (disk full, permissions, etc.):
  - Log: "WARN: EnterWorktree failed — continuing without worktree isolation"
  - Set `{{in_worktree}}` = false
  - Create branch manually: `git checkout -b {{branch_prefix}}{{branch_name}}`
    If checkout also fails (branch already exists): `git checkout {{branch_prefix}}{{branch_name}}`
    If both fail: HALT — "Could not create or switch to branch {{branch_prefix}}{{branch_name}}"
  - Continue with the skill invocation in PROJECT_ROOT (no isolation)
  - Git operations (commit, push, PR) still work on the branch
  </action>

  <check if="EnterWorktree succeeded">
    <action>**Rename branch** to our naming convention.
    Run: `git branch -m "$(git branch --show-current)" "{{branch_prefix}}{{branch_name}}"`
    </action>

    <action>**Init submodules** if needed.
    Run: `if [ -f .gitmodules ]; then timeout 30 git submodule update --init --recursive 2>&1 || echo "SUBMODULE_TIMEOUT"; fi`
    If SUBMODULE_TIMEOUT: warn "Submodule init timed out (may need auth). Continuing without."
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

  <!-- GIT: Lint, stage, and commit after dev-story -->
  <check if="{{git_enabled}} AND {{in_worktree}}">
    <action>**Lint changed files** — run:
    `bash {{project_root}}/_bmad-addons/scripts/lint-changed.sh --limit 100 --output-file lint-output.txt`
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
    `bash {{project_root}}/_bmad-addons/scripts/stage-and-commit.sh --message "feat({{epic}}): {{story-title}} ({{current_story}})" --allowlist {{project_root}}/_bmad-addons/.secrets-allowlist`
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
  `bash {{project_root}}/_bmad-addons/scripts/sync-status.sh --story "{{current_story}}" --git-status-file "{git_status_file}" --branch "{{branch_prefix}}{{branch_name}}" --platform "{{platform}}" --base-branch "{{base_branch}}"`
  </action>
</check>

<!-- GIT: Commit planning artifacts to main after planning skills -->
<check if="{{git_enabled}} AND {{completed_skill}} is a planning skill (bmad-create-prd, bmad-create-architecture, bmad-create-ux-design, bmad-create-epics-and-stories, bmad-sprint-planning, bmad-check-implementation-readiness, bmad-create-story)">
  <action>**Commit planning artifacts to main** — keep track of all planning decisions in git.
  Stage all changed artifacts:
  ```
  git add _bmad-output/planning-artifacts/ _bmad-output/implementation-artifacts/ _bmad-output/stories/ 2>/dev/null || true
  ```
  If there are staged changes, commit:
  ```
  git diff --cached --quiet || git commit -m "docs: {{completed_skill}} artifacts"
  ```
  Push to remote if possible:
  ```
  git push origin {{base_branch}} 2>/dev/null || true
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

<check if="{{next_skill}} signals completion (no further steps / sprint done / all done)">
  <goto step="10">Sprint complete</goto>
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
4. If {{git_enabled}} AND {{in_worktree}}:
   - Stage changed files explicitly: `git add -- "file1" "file2"`
   - Commit: `git commit -m "fix({{current_story}}): {{patch_title}}"`
   - Record commit SHA in `{{patch_commits}}` list
5. Mark sub-task `completed`
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
</check>

<action>Log: "All patches applied — {{N}}/{{N}} passing"</action>
<action>Mark "[story] Apply patches" → `completed`</action>

<goto step="7">Mark story done</goto>

</step>


<step n="7" goal="Mark story done, git push/PR, update records, check epic completion">

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
  1. Read PR body template: `{{project_root}}/_bmad-addons/{{pr_template}}`
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
  3. Run: `bash {{project_root}}/_bmad-addons/scripts/create-pr.sh --platform {{platform}} --branch {{branch_prefix}}{{branch_name}} --base {{pr_base}} --title "{{story-title}} ({{current_story}})" --body "<filled template>"`
  4. Output: PR URL or "SKIPPED". Set `{{pr_url}}` = output.
  If creation fails → log warning, set `{{pr_url}}` = null, continue.
  </action>

  <action>**Exit worktree** — use ExitWorktree tool:
  `ExitWorktree(action: "keep")`
  Session cwd returns to `{{project_root}}`.
  Set `{{in_worktree}}` = false.
  </action>

  <action>**Write git status** to addon's own file (NEVER modify sprint-status.yaml):
  `bash {{project_root}}/_bmad-addons/scripts/sync-status.sh --story "{{current_story}}" --git-status-file "{git_status_file}" --branch "{{branch_prefix}}{{branch_name}}" --commit "{{story_commit}}" --patch-commits "{{patch_commits_csv}}" --push-status "{{push_status}}" --pr-url "{{pr_url}}" --lint-result "{{lint_result}}" --worktree "{{project_root}}/.claude/worktrees/{{current_story}}" --platform "{{platform}}" --base-branch "{{base_branch}}"`
  This writes to `git-status.yaml` (addon-owned). Sprint-status.yaml is BMAD-owned — updated by BMAD skills only.
  </action>

  <check if="{{create_pr}} is false OR {{platform}} is git_only OR {{pr_url}} is null or SKIPPED">
    <action>**Merge story branch to main** — no PR workflow, merge locally.
    ```
    git checkout -B {{base_branch}} origin/{{base_branch}}
    git merge {{branch_prefix}}{{branch_name}} --no-edit
    git push origin {{base_branch}} 2>/dev/null || true
    ```
    If merge fails (conflict):
    - Try `git merge --abort`
    - Log warning: "Could not auto-merge {{branch_prefix}}{{branch_name}} to {{base_branch}} — manual merge required"
    - Continue without halting (the story branch is pushed)
    </action>
  </check>
  <check if="{{pr_url}} is a valid URL (not null, not SKIPPED)">
    <critical>**DO NOT merge** — a PR was created at {{pr_url}}. Merging requires PR approval. The branch will be merged through the PR workflow on the platform.</critical>
    <action>Log: "Story {{current_story}} pushed — PR awaiting review: {{pr_url}}"</action>
  </check>

  <!-- Commit all implementation artifacts and status updates to main after each story -->
  <action>**Commit story completion artifacts to main** — ensure main always reflects current sprint state.
  ```
  git checkout -B {{base_branch}} origin/{{base_branch}}
  git add _bmad-output/implementation-artifacts/ _bmad-output/stories/ _bmad-output/planning-artifacts/ 2>/dev/null || true
  git diff --cached --quiet || git commit -m "docs: story {{current_story}} done — {{test_count}} tests{{#if pr_url}}, PR: {{pr_url}}{{/if}}"
  git push origin {{base_branch}} 2>/dev/null || true
  ```
  This ensures sprint-status.yaml, git-status.yaml, story files, and any updated artifacts are on main even when story code is on a PR branch.
  </action>
</check>

<!-- Track story completion — write to addon-owned git-status.yaml (sprint-status.yaml is BMAD-owned, updated by dev-story itself) -->
<check if="{{git_enabled}}">
  <action>Update `{git_status_file}` for `{{current_story}}`: set `status: done`</action>
</check>
<check if="NOT {{git_enabled}}">
  <action>Log: "Story {{current_story}} complete — BMAD dev-story updates sprint-status.yaml directly"</action>
</check>

<action>Mark all remaining tasks for this story → `completed`</action>
<action>Increment `{{session_stories_done}}` by 1</action>

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
        1. Check if worktree at `.claude/worktrees/{{story-key}}` exists
        2. Check if clean: `git -C .claude/worktrees/{{story-key}} status --porcelain`
        3. If clean → `git worktree remove .claude/worktrees/{{story-key}}` + `git worktree prune`
           Update `{git_status_file}` for this story: `worktree_cleaned: true`
        4. If dirty → warn user, skip cleanup
      </action>
    </check>
    <check if="{{cleanup_on_merge}} is false">
      <action>Log: "Worktree cleanup skipped (git.worktree.cleanup_on_merge = false)"</action>
    </check>
  </check>
</check>

<!-- Session limit check -->
<check if="{{session_stories_done}} >= {{session_story_limit}}">
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
  <action>`ExitWorktree(action: "keep")` — preserve worktree for next session</action>
  <action>Write git status to git-status.yaml (same sync as step 7)</action>
  <action>Set `{{in_worktree}}` = false</action>
</check>

<action>Update `{state_file}` with full current state</action>

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

To continue without losing any context, please start a new session and run:
  /bmad-autopilot-on

Autopilot will resume exactly from: {{next_skill}} on {{current_story}}
No work will be repeated.
```
</action>

<action>STOP — wait for user to start a new session</action>

</step>


<step n="10" goal="Sprint complete — emit summary and next steps">

<!-- GIT: Exit worktree if still in one -->
<check if="{{in_worktree}}">
  <action>`ExitWorktree(action: "keep")`</action>
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
  <action>**Commit final artifacts and documentation to main**:
  ```
  git checkout -B {{base_branch}} origin/{{base_branch}}
  git add _bmad-output/ README.md docs/ 2>/dev/null || true
  git diff --cached --quiet || git commit -m "docs: project documentation and final artifacts"
  git push origin {{base_branch}} 2>/dev/null || true
  ```
  </action>
</check>

<action>Read `{status_file}` and collect:
  - All completed stories grouped by epic, with their story titles
  - Total story count, total epic count
  - Final test count
  - If git_enabled: all PR/MR URLs
</action>

<action>Find the app launch command by checking (in order):
  1. `run_gui.sh` or `run.sh` in the project root
  2. `main.py` in the project root
  3. Check `pyproject.toml`, `package.json`, or `setup.py` for scripts
  Record as `{{launch_cmd}}`
</action>

<!-- GIT: Release lock -->
<check if="{{git_enabled}}">
  <action>Release lock: `bash {{project_root}}/_bmad-addons/scripts/lock.sh release`</action>
</check>

<action>Delete `{state_file}` — sprint complete</action>
<action>Mark master task "BMAD Autopilot — Full Sprint Execution" → `completed`</action>

<action>Report:
```
BMAD Autopilot — Sprint Complete

Stories completed : {{total_stories}}
Epics done        : {{total_epics}}
Final test count  : {{N}}/{{N}} passed
{{#if git_enabled}}
Platform          : {{platform}}
{{/if}}

What was implemented
--------------------
[For each epic, list stories as: - [story-id] Story title{{#if pr_url}} (PR: url){{/if}}]

{{#if launch_cmd}}
Run the app
-----------
  {{launch_cmd}}
{{/if}}

Suggested manual test checklist
-------------------------------
[One bullet per story: what to do → what to see]

All automated tests are green. The application is ready for your review.
```
</action>

</step>

</workflow>
