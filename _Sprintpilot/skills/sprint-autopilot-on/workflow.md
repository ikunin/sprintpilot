# Sprintpilot — ON (Enhanced with Git Workflow)

## Purpose

You are now in **Sprintpilot Mode** with **git workflow integration**. Drive the project from its current state all the way to a working, tested, reviewed application — following BMAD's own workflow guidance at every step, with automatic git branching, commits, and PR creation.

You do NOT hardcode the workflow sequence. After each completed skill, read its output for a "next steps" recommendation and follow that. Only when no clear next step is in the output do you consult `bmad-help`. BMAD's own output is the primary oracle; `bmad-help` is the fallback.

**Git integration** is additive. If `_Sprintpilot/manifest.yaml` doesn't exist or `git.enabled: false`, all git operations are silently skipped and this workflow behaves identically to the stock autopilot.

### Shell portability

The executing shell may be bash, zsh, PowerShell, or cmd — translate bash idioms as needed:

| Bash | PowerShell |
|---|---|
| `A && B` | `A; if ($LASTEXITCODE -eq 0) { B }` |
| `A \|\| true` | `A; $LASTEXITCODE = 0` |
| `2>/dev/null` | `2>$null` |
| `rm -rf <dir>` | `Remove-Item -Recurse -Force <dir>` |
| `if [ -f X ]; then ... fi` | `if (Test-Path -PathType Leaf X) { ... }` |

For cross-platform file ops prefer the Node helpers under `_Sprintpilot/scripts/`, or inline: `node -e "require('fs').rmSync('<path>', {recursive: true, force: true})"`. When a step chains commands with `&&` and you cannot express it in one line, run them separately and STOP on any failure.

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

Log every non-trivial decision to `{decision_log_file}` (skip routine actions — running tests, staging files, creating branches). Create the file on first decision; update `last_updated` on every append.

**Categories:** `architecture`, `test-strategy`, `dependency`, `review-triage` (dismissed finding), `review-accept` (applied fix), `halt-recovery`, `scope` (outside story spec), `workaround`.
**Impact:** `low` (reversible/cosmetic), `medium` (affects one component), `high` (cross-cutting or deviates from spec).
**Phase format:** `{skill}:{sub_phase}` — e.g. `dev-story:RED`, `code-review:triage`, `autopilot:routing`.

**File schema:**
```yaml
generated: {date}
last_updated: {datetime}
decisions:
  - { id, timestamp, story, phase, category, decision, rationale, impact }
```

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
| `bmad-retrospective` | Under autopilot, handled per `autopilot.retrospective_mode`: `auto` (default — inline artifact, no external skill call), `stop` (pause so user runs `/bmad-retrospective` interactively, then resumes autopilot), or `skip` (not recommended). The external skill is NOT invoked from autopilot because it enters a multi-persona discussion loop under some CLIs. |

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

**`{state_file}` schema** (referenced as `STATE_FIELDS` below): `last_updated`, `current_story`, `current_bmad_step`, `completed_skill`, `next_skill`, `session_stories_done`, `stories_remaining`, `git_enabled`, `platform`, `in_worktree`, `pr_base`. Always update `last_updated` on every write.

**PR 6 state-write policy (`autopilot.coalesce_state_writes`):**

When the resolved profile sets `autopilot.coalesce_state_writes: true` (nano/small/medium/large by default; `legacy` false), state writes route through `state-shard.js` using a `sprint`-keyed shard as the authoritative state for sprint-level fields, and per-story shards for story-scoped fields. Policy:

- **Critical keys** (`current_story`, `current_bmad_step`, `in_worktree`, `patch_commits`) always go to shard via `state-shard.js batch`, which auto-flushes and writes straight through because the script recognizes them as crash-recovery keys.
- **Non-critical fields** (test counts, file lists, next_skill, session_stories_done, stories_remaining, etc.) go to `state-shard.js batch`, accumulating in the pending buffer. Flushed at each story boundary (step 7) and session checkpoint (step 9).
- **Merged authoritative state** (`autopilot-state.yaml`) is rebuilt via `merge-shards.js` at story boundary + session checkpoint + sprint complete.
- **Rollback** (`coalesce_state_writes: false`): every `Update {state_file}` action writes directly to `autopilot-state.yaml` via the existing STATE_FIELDS shape — no shard indirection. This is the v1.0.5 path byte-for-byte.

When the flag is `false`, the direct-write instructions below are authoritative. When `true`, substitute each `Update {state_file} with STATE_FIELDS: <changes>` with a `state-shard.js batch --story sprint --json <changes>` call, followed by a `merge-shards.js --project-root "{{project_root}}"` at the story boundary / checkpoint. The merged `autopilot-state.yaml` remains the single source of truth for resume-after-crash.

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
  - `{{granularity}}` from `git.granularity` ("story"). Resolver override wins below.
  - `{{worktree_enabled}}` from `git.worktree.enabled` (true). Resolver override wins below.
  - `{{squash_on_merge}}` from `git.squash_on_merge` (false). Resolver override wins below.
  </action>
  <action>**Apply profile overrides** via resolver — run each and set only if the resolver returns a value:
  - `node {{project_root}}/_Sprintpilot/scripts/resolve-profile.js get git.granularity` → override `{{granularity}}`.
  - `node {{project_root}}/_Sprintpilot/scripts/resolve-profile.js get git.worktree.enabled` → override `{{worktree_enabled}}`.
  - `node {{project_root}}/_Sprintpilot/scripts/resolve-profile.js get git.squash_on_merge` → override `{{squash_on_merge}}`.
  </action>
  <action>Read `{project-root}/_Sprintpilot/modules/autopilot/config.yaml` (if present) and set:
  - `{{session_story_limit}}` from `autopilot.session_story_limit` (default: 3). A value of 0 disables the limit (run until sprint complete).
  - `{{retrospective_mode}}` from `autopilot.retrospective_mode` (default: `auto`). Valid values: `auto` | `stop` | `skip`. Any unknown value falls back to `auto`.
  If the file or either key is missing, fall back to the defaults above.
  </action>
  <action>**Resolve profile-driven flow** — run:
  `node {{project_root}}/_Sprintpilot/scripts/resolve-profile.js get autopilot.implementation_flow`
  Output: `full` or `quick`. Set `{{implementation_flow}}` = output. Default to `full` if the call fails.
  Run: `node {{project_root}}/_Sprintpilot/scripts/resolve-profile.js get autopilot.session_story_limit` → override `{{session_story_limit}}` if the resolver produces a different value than config.yaml (profile overrides config silence). Same pattern for `autopilot.retrospective_mode`.
  </action>
  <action>**Resolve coalesce flag** — run:
  `node {{project_root}}/_Sprintpilot/scripts/resolve-profile.js get autopilot.coalesce_state_writes` → `{{coalesce_state_writes}}`. Default `false` on failure.
  </action>
  <!-- PR 11: detect the running host and resolve parallel-dispatch config. -->
  <action>**Detect host agent** — run:
  `node {{project_root}}/_Sprintpilot/scripts/agent-adapter.js detect --project-root "{{project_root}}"`
  Parse the JSON output: set `{{host_agent}}` = host, `{{host_supports_parallel}}` = supports_parallel, `{{host_confidence}}` = confidence.
  </action>
  <action>**Resolve parallelism flags** via the profile resolver:
  - `{{parallel_stories}}` from `ma.parallel_stories` (default false).
  - `{{max_parallel_stories}}` from `ma.max_parallel_stories` (default 2).
  - `{{experimental_parallel_on_gemini}}` from `ma.experimental_parallel_on_gemini` (default false).
  </action>
  <!-- Gemini CLI opt-in: when the user explicitly sets
       experimental_parallel_on_gemini=true AND the detected host is
       gemini-cli at HIGH confidence, promote supports_parallel=true
       with a one-line warning. Worktree-scoped subagents aren't shipped
       upstream yet, so this is user-opt-in-per-project. -->
  <check if="{{experimental_parallel_on_gemini}} is true AND {{host_agent}} is gemini-cli AND {{host_confidence}} is high">
    <action>Set `{{host_supports_parallel}}` = true</action>
    <action>Log once: "EXPERIMENTAL: parallel_stories enabled on Gemini CLI via ma.experimental_parallel_on_gemini=true. Worktree-scoped subagents are not yet shipped upstream (gemini-cli#22967); expect possible serialization or quota throttling."</action>
  </check>
  <action>Silently coerce `{{parallel_stories}}` to false when `{{host_supports_parallel}}` is false OR `{{host_confidence}}` is not `high`. Log once:
  `parallel_stories requested but host '{{host_agent}}' does not declare parallel support (confidence={{host_confidence}}); running sequentially`.
  </action>
</check>

<check if="manifest does NOT exist">
  <action>Set `{{git_enabled}}` = false</action>
  <action>Set `{{session_story_limit}}` = 3</action>
  <action>Set `{{retrospective_mode}}` = `auto`</action>
  <action>Set `{{implementation_flow}}` = `full`</action>
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

  <action>**Check for `origin` remote** — run: `git remote get-url origin`
  If the command fails (exit code != 0), no `origin` remote is configured. Set `{{has_origin}}` = false.
  Otherwise set `{{has_origin}}` = true.
  </action>
  <check if="{{has_origin}} is false">
    <action>Log: "WARN: no `origin` remote configured — running in local-only mode. Remote operations (fetch, push, PR, branch reconciliation) will be skipped. Add a remote later with: `git remote add origin <url>`"</action>
    <action>Set `{{push_auto}}` = false</action>
    <action>Set `{{create_pr}}` = false</action>
    <action>Set `{{platform}}` = "git_only"</action>
  </check>

  <!-- PR 10: disable gc.auto on the main repo so git's auto-GC doesn't
       race with concurrent worktree operations during the sprint. Save
       the prior value so we can restore it at sprint complete (step 10). -->
  <action>**Save + disable main-repo gc.auto**: set `{{original_gc_auto_main}}` = output of `git config --get gc.auto 2>/dev/null || echo unset`, then `git config --local gc.auto 0`.</action>

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

  <!-- PR 7 CONDITIONAL BOOT WORK: a clean repo — main worktree only, zero
       in-progress stories — can skip the slow health-check + branch
       reconciliation below. Gate honored by non-legacy, non-large profiles
       (large keeps full reconciliation for compliance/uptime reasons). -->
  <action>Read `autopilot.conditional_boot_work` from the resolver:
  `node {{project_root}}/_Sprintpilot/scripts/resolve-profile.js get autopilot.conditional_boot_work` → `{{conditional_boot_work}}`. Default to `false` on failure.
  </action>
  <action>Count worktrees (every supported git install ships `git worktree list --porcelain`):
  `git worktree list --porcelain 2>/dev/null | grep -c '^worktree '` → `{{worktree_count}}`. Fail-open to 2 (force full path) if the command fails.
  </action>
  <action>Count in-progress stories: read `{status_file}` and count stories whose status is NOT in {`done`, `backlog`}. Set `{{in_progress_count}}`. Fail-open to 1 (force full path) if the file is unreadable.</action>

  <check if="{{conditional_boot_work}} is true AND {{worktree_count}} is 1 AND {{in_progress_count}} is 0">
    <action>Log: "Boot fast-path (PR 7): clean repo — skipping health-check + branch reconciliation"</action>
    <action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js once --story "sprint" --phase "boot.fast-path" --meta "{\"reason\":\"clean-repo\"}" --project-root "{{project_root}}"` — ignore failures.</action>
    <action>Set `{{git_enabled}}` = true, `{{platform}}` = detected value</action>
  </check>

  <check if="NOT ({{conditional_boot_work}} is true AND {{worktree_count}} is 1 AND {{in_progress_count}} is 0)">

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
  Skip this entire section if `{{has_origin}}` is false (no remote → nothing to reconcile).
  Run as separate commands — **if `git fetch origin` fails (no remote/network/auth), STOP branch reconciliation and log a warning; do not operate on stale local refs**:
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

  </check><!-- end PR 7 conditional boot work (non-fast-path branch) -->
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

  <!-- Resume from a `retrospective_mode: stop` pause. -->
  <check if="{state_file}.paused_at is epic-complete-awaiting-retrospective">
    <action>Set `{{paused_epic_id}}` from `{state_file}.paused_epic_id`. Check if epic `{{paused_epic_id}}` is `done` in `{status_file}` OR an artifact exists at `{implementation_artifacts}/retrospectives/epic-{{paused_epic_id}}-*.md`.</action>
    <check if="epic is done OR retrospective artifact exists">
      <action>Clear `paused_at`, `paused_epic_id`, `next_action` from `{state_file}`. Log: "Epic {{paused_epic_id}} retrospective detected — resuming autopilot".</action>
    </check>
    <check if="epic is NOT done AND no retrospective artifact">
      <action>Report: "Autopilot still paused — epic {{paused_epic_id}} retrospective not yet done. Run `/bmad-retrospective` interactively, then re-run `/sprint-autopilot-on`. (To bypass: set `retrospective_mode` to `auto` or `skip` in `_Sprintpilot/modules/autopilot/config.yaml`.)" Then STOP.</action>
    </check>
  </check>

  <goto step="2">Jump to execution loop with reconciled state</goto>
</check>

<check if="state_file does NOT exist">
  <action>Check if `{status_file}` exists. If NOT, do NOT jump to `bmad-sprint-planning` (Phase 4 skill, requires Phase 1–3 artifacts). Invoke `bmad-help` — "No sprint-status.yaml found. What is the current phase and which skill should run first?" — and set `{{next_skill}}` from its response. Expected routing: no PRD → `bmad-create-prd` (BLOCKER); PRD → `bmad-create-architecture`; architecture → `bmad-create-epics-and-stories`; epics → `bmad-sprint-planning`.</action>

  <check if="{{git_enabled}} AND status_file did not exist AND {{next_skill}} is bmad-sprint-planning (planning just completed earlier in this flow)">
    <action>Run `git fetch origin` — warn + skip on failure (no remote/auth/network), do not abort bootstrap.</action>
    <action>Initialize `{git_status_file}` (addon-owned — NEVER write git fields to sprint-status.yaml) with: `git_integration: { enabled: true, base_branch: <from config>, platform: {{platform}} }` and empty `stories:`.</action>
  </check>

  <action>Read `{status_file}` — find all stories not yet `done`</action>
  <action>Invoke `bmad-help` — "What is the current project state and next required workflow step?"</action>
  <action>Extract:
    - `{{current_phase}}` — lifecycle phase
    - `{{next_skill}}` — next required skill
    - `{{session_stories_done}}` = 0
  </action>
  <action>Create master task: "Sprintpilot — Full Sprint Execution" → `in_progress`</action>
  <action>**Compute `{{stories_remaining}}`** from `{status_file}`. Rules (explicit — do NOT guess):
  - Parse every entry under `development_status:` (canonical) OR `stories:` (alternate).
  - Include the story key (the child key, e.g. `1-2-cli-interface`) in `{{stories_remaining}}` IF its `status` field is ANYTHING other than the literal string `done`. That includes `backlog`, `ready-for-dev`, `in-progress`, `review`, `draft`, missing, null — all non-done states count as "remaining".
  - Exclude top-level epic entries (e.g. under `epics:` block) — only story keys go in the list.
  - If `development_status`/`stories` is missing or empty (pre-planning state), set `{{stories_remaining}}` to `[]` — planning will repopulate the file and a later recalculation will pick up the stories.
  </action>
  <action>Write initial `{state_file}` with STATE_FIELDS: `current_story = null`, `current_bmad_step = null`, `completed_skill = bmad-help`, `session_stories_done = 0`, `stories_remaining = {{stories_remaining}}` (computed above), `in_worktree = false`, `pr_base = {{base_branch}}`.</action>
  <action>Report to user:
  ```
  Sprintpilot ON

  Phase: {{current_phase}}
  First step: {{next_skill}}
  Git integration: {{git_enabled}}
  Platform: {{platform}}
  Session limit: {{session_story_limit}} stories, then checkpoint + new session
  Retrospective mode: {{retrospective_mode}}

  Beginning autonomous execution. I will only stop for true blockers or session checkpoints.
  ```
  </action>
</check>

</step>


<step n="2" goal="Main execution loop — route to correct handler">

<!-- PR 12 CROSS-EPIC PARALLELISM (experimental, off by default on every
     profile including `large`). All safety rails must pass:
       1. ma.parallel_epics is true.
       2. Host confidence is HIGH AND supports_parallel is true (same as
          intra-epic gate in PR 11).
       3. Two or more epics in dependencies.yaml declare `independent: true`.
       4. preflight-merge.js reports NO conflicts between all pairs.
       5. Session-scoped disable flag {{cross_epic_disabled_this_session}}
          is false (flips true after any cross-epic merge conflict).
     Only on the first iteration of the loop — subsequent iterations
     don't re-preflight; they consume the cached safe_pairs list. -->
<action>Resolve `{{parallel_epics}}` from `ma.parallel_epics` (default false) via the resolver.</action>
<check if="{{parallel_epics}} is true AND {{host_supports_parallel}} is true AND {{host_confidence}} is high AND {{cross_epic_preflight_done}} is not true AND {{cross_epic_disabled_this_session}} is not true">
  <action>Read `_Sprintpilot/sprints/dependencies.yaml` (if present). Extract every epic id where `epics.<id>.independent` is true. Set `{{independent_epic_ids}}` = comma-joined list of ids.</action>
  <check if="{{independent_epic_ids}} has fewer than 2 ids">
    <action>Log once: "cross-epic parallelism enabled but fewer than 2 epics declare `independent: true` in dependencies.yaml — running sequentially"</action>
    <action>Set `{{cross_epic_preflight_done}}` = true, `{{cross_epic_safe_pairs}}` = []</action>
  </check>
  <check if="{{independent_epic_ids}} has 2 or more ids">
    <action>Run: `node {{project_root}}/_Sprintpilot/scripts/preflight-merge.js --epics "{{independent_epic_ids}}" --base "{{base_branch}}" --branch-prefix "{{branch_prefix}}" --project-root "{{project_root}}"`. Parse JSON — set `{{cross_epic_safe_pairs}}` = safe_pairs, `{{cross_epic_conflict_pairs}}` = conflict_pairs.</action>
    <action>Log: "EXPERIMENTAL: parallel_epics preflight → safe={{cross_epic_safe_pairs.length}} conflict={{cross_epic_conflict_pairs.length}} checked=N"</action>
    <action>Set `{{cross_epic_preflight_done}}` = true</action>
  </check>
</check>

<!-- Authoritative "sprint complete" check. Read the status file EVERY
     iteration (do not rely on stale stories_remaining). A story counts
     as done iff its status field equals the literal string "done". A
     file with no development_status / stories block is PRE-PLANNING
     and is NOT sprint-complete — we must route to planning, not to
     step 10. -->
<action>**Recalculate `{{stories_remaining}}`** from `{status_file}` now (authoritative):
- Parse every entry under `development_status:` or `stories:`.
- A story key goes into `{{stories_remaining}}` when its `status` is NOT the literal string `done` (so backlog, ready-for-dev, in-progress, review, draft, missing, null all count as remaining).
- Set `{{sprint_has_stories}}` = true iff at least one story key was found in the file (regardless of status).
- Set `{{sprint_is_complete}}` = true iff `{{sprint_has_stories}}` is true AND `{{stories_remaining}}` is empty.
</action>
<check if="{{sprint_is_complete}} is true">
  <goto step="10">Sprint complete</goto>
</check>
<check if="{{sprint_has_stories}} is false">
  <action>Log: "Sprint pre-planning: no stories in status file yet. Routing through bmad-help to the next planning skill (do NOT go to step 10)."</action>
</check>

<check if="{{next_skill}} is empty">
  <action>**Recover next_skill** — re-read `{status_file}`, find first story with status != "done"</action>
  <check if="no undone stories found AND {{sprint_has_stories}} is true">
    <goto step="10">Sprint complete</goto>
  </check>
  <action>If `{{sprint_has_stories}}` is true: set `{{current_story}}` = first undone story from `{status_file}`.</action>
  <action>Invoke `bmad-help` — "Story {{current_story}} needs attention (or: sprint in planning phase — no stories yet). What is the next required workflow step?"</action>
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

<!-- PR 4 NANO ROUTING: when the active profile's implementation_flow is
     'quick', route bmad-dev-story through bmad-quick-dev instead. Quick-dev
     runs Implement → Review → Classify → Commit internally (BMad
     step-oneshot.md), so bmad-create-story / bmad-check-readiness /
     bmad-code-review are not invoked in this flow. -->
<check if="{{implementation_flow}} is quick AND {{next_skill}} is bmad-dev-story">
  <action>Override `{{next_skill}}` = `bmad-quick-dev`</action>
  <action>Log: "Routing {{current_story}} through bmad-quick-dev per nano profile (implementation_flow=quick)"</action>
</check>
<!-- Under quick flow, autopilot never invokes bmad-create-story or
     bmad-check-implementation-readiness; quick-dev reads AC from
     sprint-status.yaml directly. If bmad-help proposes these skills
     while implementation_flow=quick, skip them and advance. -->
<check if="{{implementation_flow}} is quick AND ({{next_skill}} is bmad-create-story OR {{next_skill}} is bmad-check-implementation-readiness)">
  <action>Log: "Skipping {{next_skill}} under quick flow (nano profile) — quick-dev reads AC directly"</action>
  <action>Set `{{next_skill}}` = `bmad-quick-dev`</action>
</check>

<action>Set `{{completed_skill}}` = `{{next_skill}}`</action>
<action>Create task "{{next_skill}}" → mark `in_progress`</action>

<check if="{{next_skill}} is a per-story skill (bmad-dev-story, bmad-quick-dev, bmad-code-review, bmad-create-story)">
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

<!-- PR 5: determine per-story epic key + title so the workflow can branch
     per-epic under granularity=epic and decide "is this the last story
     of the epic". Epic ID is the leading numeric segment of the story
     key (e.g. '1-2-foo' → '1'); slug is the epic's title from sprint-
     status.yaml (or the epic header in the epics file). Skip if empty. -->
<action>Set `{{epic_id}}` = leading numeric segment of `{{current_story}}` (e.g. `1-2-foo` → `1`). If the key doesn't match `^\d+-`, leave `{{epic_id}}` = "".</action>
<action>Set `{{epic_branch_name}}` = `epic-{{epic_id}}` (only used when `{{granularity}} = epic`).</action>
<action>**Detect first vs last story of epic** — read `{status_file}` (BMAD-owned; do not modify). Find all stories with the same `{{epic_id}}`:
  - `{{is_first_story_of_epic}}` = true if no story in this epic has status `in-progress` or `done` yet (i.e. current story is the first to enter dev-story / quick-dev).
  - `{{is_last_story_of_epic}}` = true if this is the final undone story in the epic (after this story, all other stories in the epic are `done`).
  Both default to true when `{{epic_id}}` = "" (single-story "epic").
</action>

<!-- GIT: Enter worktree OR create/reuse epic branch before dev-story OR quick-dev.
     Nano's profile sets worktree.enabled=false + granularity=epic, so this
     block falls through to in-place branching. -->
<check if="{{git_enabled}} AND ({{next_skill}} is bmad-dev-story OR {{next_skill}} is bmad-quick-dev)">
  <action>**Sanitize branch name**: `node {{project_root}}/_Sprintpilot/scripts/sanitize-branch.js "{{current_story}}" --prefix "{{branch_prefix}}" --max-length 60`. Set `{{branch_name}}` = output. Full ref: `{{branch_prefix}}{{branch_name}}`.</action>

  <action>**Idempotency check** — if branch is already registered in `{status_file}` for this story AND its worktree exists, skip creation. If registered without worktree → recovery mode (see health check). Otherwise proceed.</action>

  <action>**Pick branch point.** If `{{has_origin}}` is true: `git fetch origin` (warn + continue on failure). If `{{has_origin}}` is false: skip fetch, use local refs.

  Read `{git_status_file}` for earlier stories in this epic; find the latest with `push_status = "pushed"` AND a valid `pr_url`; check if merged to base: `git merge-base --is-ancestor origin/{{branch_prefix}}<prev-branch> origin/{{base_branch}}`.
  - If unmerged previous story exists (requires `{{has_origin}}`): `git checkout origin/{{branch_prefix}}<prev-branch>`, set `{{pr_base}}` = `{{branch_prefix}}<prev-branch>`.
  - Otherwise: `git checkout origin/{{base_branch}}` (or local `{{base_branch}}` if no origin), set `{{pr_base}}` = `{{base_branch}}`.

  Detached HEAD is fine — `git worktree add` below creates a new branch from HEAD.
  </action>

  <!-- PR 5: epic granularity — share one branch per epic instead of one per story.
       Under worktree.enabled=false + granularity=epic (nano default),
       subsequent stories of the same epic check out the epic branch in
       place and commit there; no worktree is created. -->
  <check if="{{granularity}} is epic">
    <action>Override `{{branch_name}}` = `{{epic_branch_name}}` (shared across all stories in this epic).</action>
    <check if="{{is_first_story_of_epic}} is true">
      <action>Log: "Epic granularity: creating epic branch {{branch_prefix}}{{epic_branch_name}} for the first story of epic {{epic_id}}"</action>
    </check>
    <check if="{{is_first_story_of_epic}} is false">
      <action>Log: "Epic granularity: reusing existing epic branch {{branch_prefix}}{{epic_branch_name}} for story {{current_story}}"</action>
    </check>
  </check>

  <check if="{{worktree_enabled}} is false">
    <action>**In-place branching** (granularity=epic or worktree.enabled=false): `git checkout -B {{branch_prefix}}{{branch_name}} 2>&1`. No worktree. Set `{{in_worktree}}` = false. Skip the worktree-add block below.</action>
  </check>

  <check if="{{worktree_enabled}} is true">
    <action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js start --story "{{current_story}}" --phase "worktree.add" --project-root "{{project_root}}"` — ignore failures.</action>
    <action>**Create worktree.** Try: `git worktree add "{{project_root}}/.worktrees/{{current_story}}" -b "{{branch_prefix}}{{branch_name}}" 2>&1`. If it fails because the branch already exists, retry without `-b`: `git worktree add "{{project_root}}/.worktrees/{{current_story}}" "{{branch_prefix}}{{branch_name}}" 2>&1`.

  If both fail (disk/permissions): log "WARN: worktree add failed — continuing without isolation", set `{{in_worktree}}` = false, and fall back to branch-only mode: `git checkout -b {{branch_prefix}}{{branch_name}}` (retry without `-b` if branch exists). HALT only if the checkout also fails. Git push/PR still work on the branch.
    </action>
    <action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js end --story "{{current_story}}" --phase "worktree.add" --project-root "{{project_root}}"` — ignore failures.</action>
  </check>

  <check if="{{worktree_enabled}} is true AND worktree add succeeded">
    <action>`cd {{project_root}}/.worktrees/{{current_story}}`. All subsequent commands run from here. Set `{{worktree_path}}` = this path.</action>
    <action>**Disable gc.auto on this worktree** (PR 10): save original value `{{original_gc_auto_worktree}}` = output of `git -C {{project_root}}/.worktrees/{{current_story}} config --get gc.auto` (or "unset"), then `git -C {{project_root}}/.worktrees/{{current_story}} config --local gc.auto 0`.</action>
    <action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js start --story "{{current_story}}" --phase "worktree.submodule-init" --project-root "{{project_root}}"` — ignore failures.</action>
    <action>**Init submodules** if `.gitmodules` exists (file-exists check via `node -e "process.exit(require('fs').existsSync('.gitmodules')?0:1)"`). PR 10 fast-path:
    Resolve the main repo's common git dir: `GIT_COMMON=$(git -C {{project_root}} rev-parse --git-common-dir)`.
    For each submodule path in `.gitmodules`:
      1. `node {{project_root}}/_Sprintpilot/scripts/submodule-lock.js acquire --submodule "<path>" --project-root "{{project_root}}"` — serializes concurrent submodule updates across worktrees.
      2. With git ≥ 2.18 (confirmed at boot by check-prereqs): wrap the update with retry to survive ref-lock contention:
         `node {{project_root}}/_Sprintpilot/scripts/with-retry.js -- git -C {{project_root}}/.worktrees/{{current_story}} submodule update --init --recursive --reference "$GIT_COMMON" --jobs=4 -- <path>`
         With older git (degraded mode flagged by check-prereqs): fall back to `git -C ... submodule update --init --recursive -- <path>`.
      3. `node {{project_root}}/_Sprintpilot/scripts/submodule-lock.js release --submodule "<path>" --project-root "{{project_root}}"` (best-effort, ignore failures).
    If the loop fails or hangs: warn "Submodule init failed (may need auth). Continuing." and proceed.
    </action>
    <action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js end --story "{{current_story}}" --phase "worktree.submodule-init" --project-root "{{project_root}}"` — ignore failures.</action>
    <action>Set `{{in_worktree}}` = true</action>
  </check>
  <action>Update `{state_file}` (write to the worktree copy since cwd is now the worktree)</action>
</check>

<action>Update `{state_file}` with STATE_FIELDS (set `current_bmad_step = executing`, `completed_skill = <previous skill>`).</action>
<check if="{{coalesce_state_writes}} is true">
  <action>Mirror critical keys to the shard (bypasses batching for crash-recovery correctness):
  `node {{project_root}}/_Sprintpilot/scripts/state-shard.js batch --story sprint --json "{\"current_bmad_step\":\"executing\",\"current_story\":\"{{current_story}}\",\"completed_skill\":\"<previous skill>\"}" --project-root "{{project_root}}"` — ignore failures.
  </action>
</check>

<!-- Autopilot menu handling rules apply — see AUTOPILOT RULES section above -->

<!-- PHASE TIMING: emit start/end around every skill invocation.
     Use `{{current_story}}` when set, else the sentinel `sprint` for
     sprint-level skills (bmad-help, bmad-sprint-planning, etc).
     The script is a silent no-op when autopilot.phase_timings is false. -->
<action>Set `{{timing_story}}` = `{{current_story}}` if non-empty, else `sprint`.</action>
<action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js start --story "{{timing_story}}" --phase "skill.{{next_skill}}" --project-root "{{project_root}}"` — ignore failures.</action>
<action>INVOKE `{{next_skill}}` skill using the Skill tool</action>
<action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js end --story "{{timing_story}}" --phase "skill.{{next_skill}}" --project-root "{{project_root}}"` — ignore failures.</action>
<action>Mark task "{{next_skill}}" as `completed`</action>

<goto step="4">Handle completion</goto>

</step>


<step n="4" goal="Handle skill completion and route to next action">

<!-- PR 4 NANO ROUTING: quick-dev completion handler.
     Quick-dev's one-shot (step-oneshot.md:44) already ran Implement →
     Review → Classify → Commit internally. Autopilot skips the external
     bmad-code-review step and jumps straight to step 7 (mark story
     done). Escalation safety net: if tests fail or classify severity is
     high, flip implementation_flow to full for the rest of the session. -->
<check if="{{completed_skill}} was bmad-quick-dev">
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js start --story "{{current_story}}" --phase "tests.run" --project-root "{{project_root}}"` — ignore failures.</action>
  <action>Verify tests ran — if not, run them now: report `N/N passed`. Record pass/fail into `{{tests_passed}}`.</action>
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js end --story "{{current_story}}" --phase "tests.run" --project-root "{{project_root}}"` — ignore failures.</action>
  <action>Read quick-dev's Classify severity from its stdout/output. If its output mentions `severity: high` or a failing classify, set `{{quickdev_severity_high}}` = true.</action>
  <check if="{{tests_passed}} is false OR {{quickdev_severity_high}} is true">
    <action>**Escalation** — flip the session-scoped flow to `full`: set `{{implementation_flow}}` = `full`. Do NOT write this back to config.yaml; it is session-only. Log decision: `category=scope, phase=autopilot:escalation, impact=medium, "nano story {{current_story}} triggered fallback (tests_passed={{tests_passed}}, severity_high={{quickdev_severity_high}}) — subsequent stories use full cycle"` to `{decision_log_file}`.</action>
  </check>
  <action>Set `{{next_skill}}` = "(none)" — quick-dev handled review + commit internally per BMad step-oneshot.md.</action>
  <goto step="7">Mark story done</goto>
</check>

<check if="{{completed_skill}} was bmad-dev-story">
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js start --story "{{current_story}}" --phase "tests.run" --project-root "{{project_root}}"` — ignore failures.</action>
  <action>Verify tests ran — if not, run them now: report `N/N passed`</action>
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js end --story "{{current_story}}" --phase "tests.run" --project-root "{{project_root}}"` — ignore failures.</action>
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
    `node {{project_root}}/_Sprintpilot/scripts/log-timing.js start --story "{{current_story}}" --phase "git.commit" --project-root "{{project_root}}"` (ignore failures), then
    `node {{project_root}}/_Sprintpilot/scripts/stage-and-commit.js --message "feat({{epic}}): {{story-title}} ({{current_story}})" --allowlist {{project_root}}/_Sprintpilot/.secrets-allowlist`, then
    `node {{project_root}}/_Sprintpilot/scripts/log-timing.js end --story "{{current_story}}" --phase "git.commit" --project-root "{{project_root}}"` (ignore failures).
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

<check if="{{completed_skill}} is retrospective-auto">
  <action>Log: "Epic retrospective generated inline by autopilot — sprint-status.yaml updated"</action>
</check>

<check if="{{completed_skill}} is retrospective-skip">
  <action>Log: "Epic retrospective skipped per config — sprint-status.yaml updated inline"</action>
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

<check if="{{completed_skill}} was bmad-sprint-planning">
  <!-- PR-follow-up: sprint-planning populates development_status for the
       first time. Recalculate stories_remaining so the step-2 "sprint
       complete" gate doesn't fire spuriously on the next iteration. -->
  <action>**Recalculate `{{stories_remaining}}`** from `{status_file}` using the same rules as step 1 initial-write: include every story key whose status is NOT the literal `done`. Update `{state_file}` with the new `{{stories_remaining}}`.</action>
</check>

<check if="{{completed_skill}} was bmad-sprint-planning AND {{git_enabled}}">
  <action>If `{{has_origin}}` is true, run `git fetch origin` (log a warning on failure and continue — do not abort).
  If `{{has_origin}}` is false, skip the fetch.</action>
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

<check if="{{git_enabled}} AND {{completed_skill}} is a planning skill (bmad-create-prd, bmad-create-architecture, bmad-create-ux-design, bmad-create-epics-and-stories, bmad-sprint-planning, bmad-check-implementation-readiness, bmad-create-story)">
  <action>**Commit planning artifacts to main.**
  1. `git add _bmad-output/planning-artifacts/ _bmad-output/implementation-artifacts/ _bmad-output/stories/` (ignore missing-path errors)
  2. If `git diff --cached --quiet` exits non-zero: `git commit -m "docs: {{completed_skill}} artifacts"` then `git push origin {{base_branch}}` (warn on push failure, do not halt).
  </action>
</check>

<goto step="5">Read skill output for next step</goto>

</step>


<step n="5" goal="Determine next skill — from skill output first, bmad-help as fallback">

<action>Read the output of `{{completed_skill}}`. If it contains "Next Steps", "What to do next", "Run next", or equivalent, extract `{{next_skill}}` from that section. Otherwise invoke `bmad-help` — "{{completed_skill}} just finished. What is the next required workflow step?" — and extract `{{next_skill}}` from its response. Log the source ("skill output" vs "bmad-help fallback").</action>

<check if="{{next_skill}} is null, empty, or signals completion">
  <action>**Verify against source of truth** — re-read `{status_file}`. If undone stories exist, set `{{current_story}}` = first one and determine `{{next_skill}}`:
    - No story file → `bmad-create-story`
    - Story file + status `ready-for-dev` → `bmad-check-implementation-readiness`
    - Status `in-progress` and `current_bmad_step` before `code-review` → `bmad-dev-story`
    - Status `in-progress` and `current_bmad_step` ≥ `code-review` → `bmad-code-review`
    - Else → invoke `bmad-help` for precise determination
  Log: "next_skill was empty but undone stories remain — resolved to {{next_skill}} for {{current_story}}".
  </action>
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
<action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js start --story "{{current_story}}" --phase "skill.bmad-code-review.rereview" --project-root "{{project_root}}"` — ignore failures.</action>
<action>Re-invoke `bmad-code-review` using the Skill tool.
The review layers already ran — this pass will see zero unresolved findings and set the story status to `done` in sprint-status.yaml (code-review owns that transition per step-04-present.md:92).
Instruct: "Re-verify code review for story {{current_story}} — all patch findings have been applied. Update story status accordingly."
</action>
<action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js end --story "{{current_story}}" --phase "skill.bmad-code-review.rereview" --project-root "{{project_root}}"` — ignore failures.</action>
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

<!-- PR 5: epic granularity — defer push/PR until the LAST story of the epic.
     For intermediate stories (granularity=epic AND not is_last_story_of_epic):
     the work is already committed to the epic branch locally via stage-and-
     commit.js; no push or PR is attempted. The epic's last story pushes
     the accumulated commits and opens one PR for the whole epic. -->
<check if="{{granularity}} is epic AND {{is_last_story_of_epic}} is false">
  <action>Log: "Epic granularity: skipping push/PR for {{current_story}} — will push at end of epic {{epic_id}}"</action>
  <action>Set `{{push_status}}` = "deferred", `{{pr_url}}` = "DEFERRED", `{{merge_status}}` = "deferred"</action>
  <!-- Skip the whole git-push block; fall through to the artifact-sync block below. -->
</check>

<!-- GIT: Push, PR, exit worktree (story granularity OR last story of an epic) -->
<check if="{{git_enabled}} AND ({{granularity}} is story OR {{is_last_story_of_epic}} is true) AND ({{in_worktree}} OR {{worktree_enabled}} is false)">
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
    <action>**Merge story/epic branch to main.** If `{{has_origin}}` is false (local-only), substitute `origin/{{base_branch}}` → `{{base_branch}}` and skip all `git push origin` / `git fetch origin` calls below.
    Choose merge strategy by `{{squash_on_merge}}` (PR 5): if true, use `git merge --squash` + single commit; otherwise standard merge commit.
    1. `git checkout -B {{base_branch}} origin/{{base_branch}}`
    2. If `{{squash_on_merge}}` is true:
       `git merge --squash {{branch_prefix}}{{branch_name}}` then
       `git commit -m "feat({{epic_id}}): epic {{epic_id}} ({{branch_prefix}}{{branch_name}})"`.
       Otherwise: `git merge {{branch_prefix}}{{branch_name}} --no-edit`.
    3. On success: `git push origin {{base_branch}}`, set `{{merge_status}}` = "merged".
    4. On conflict: `git merge --abort`, `git fetch origin`, re-checkout base, retry merge once. On retry success: push + merged. On retry failure: `{{merge_status}}` = "failed", log warning, continue — the branch is preserved and boot reconciliation retries next session.
    5. **PR 12 cross-epic conflict interlock**: if this merge conflict involved two independent epics AND `{{parallel_epics}}` is true, set `{{cross_epic_disabled_this_session}}` = true and log "EXPERIMENTAL: cross-epic merge conflict detected; disabling parallel_epics for the remainder of this session." The flag resets on next session start.

    `{{merge_status}}` is persisted by the sync-status.js call later in this step (via `--merge-status`). Do NOT call sync-status.js here — it does full block replacement and would destroy other fields.
    </action>
    <check if="{{cleanup_on_merge}} is true AND {{in_worktree}} is true">
      <action>**Cleanup worktree** (ignore failures — may already be gone): `git worktree remove .worktrees/{{current_story}} --force` then `git worktree prune`</action>
    </check>
  </check>
  <check if="{{pr_url}} is a valid URL (not null, not SKIPPED)">
    <critical>**DO NOT merge** — a PR was created at {{pr_url}}. Merging requires PR approval. The branch will be merged through the PR workflow on the platform.</critical>
    <action>Set `{{merge_status}}` = "pr_pending"</action>
    <action>Log: "Story {{current_story}} pushed — PR awaiting review: {{pr_url}}"</action>
  </check>

  <action>**Commit story artifacts to main** — keeps main in sync even when story code is on a PR branch.
  1. `git checkout -B {{base_branch}} origin/{{base_branch}}`
  2. Write git-status.yaml (addon-owned — never touch sprint-status.yaml): `node {{project_root}}/_Sprintpilot/scripts/sync-status.js --story "{{current_story}}" --git-status-file "{{project_root}}/_bmad-output/implementation-artifacts/git-status.yaml" --branch "{{branch_prefix}}{{branch_name}}" --commit "{{story_commit}}" --patch-commits "{{patch_commits_csv}}" --push-status "{{push_status}}" --merge-status "{{merge_status}}" --pr-url "{{pr_url}}" --lint-result "{{lint_result}}" --worktree "{{project_root}}/.worktrees/{{current_story}}" --platform "{{platform}}" --base-branch "{{base_branch}}"`
  3. Stage artifacts (ignore errors for missing paths): `git add _bmad-output/implementation-artifacts/sprint-status.yaml _bmad-output/implementation-artifacts/git-status.yaml _bmad-output/implementation-artifacts/autopilot-state.yaml _bmad-output/implementation-artifacts/decision-log.yaml _bmad-output/stories/ _bmad-output/planning-artifacts/`
  4. If `git diff --cached --quiet` exits non-zero: `git commit -m "docs: story {{current_story}} done — {{test_count}} tests{{#if pr_url}}, PR: {{pr_url}}{{/if}}"` then `git push origin {{base_branch}}` (warn on push failure, do not halt).
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

<!-- PR 6 STORY-BOUNDARY FLUSH: if coalescing is on, flush the sprint
     shard's pending buffer now (writes accumulated non-critical fields
     to the shard) and merge all shards into the authoritative
     autopilot-state.yaml / decision-log.yaml. Fast on a single-story
     sprint; amortized when multiple stories complete per session. -->
<check if="{{coalesce_state_writes}} is true">
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/state-shard.js flush --story sprint --project-root "{{project_root}}"` — ignore failures.</action>
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/state-shard.js flush --story "{{current_story}}" --project-root "{{project_root}}"` — ignore failures (no-op if no per-story shard was ever batched).</action>
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/merge-shards.js --project-root "{{project_root}}"` — ignore failures. Produces merged autopilot-state.yaml + decision-log.yaml.</action>
</check>

<action>Report: "Story {{current_story}} done — N/N passing{{#if pr_url}} — PR: {{pr_url}}{{/if}}"</action>

<action>Check if ALL stories in this epic are `done`</action>
<check if="epic complete">
  <action>Resolve `{{epic_id}}` (e.g. "1") and `{{epic_title}}` from `{status_file}` for the current epic</action>
  <action>Create task "[epic {{epic_id}}] retrospective" → `in_progress`</action>

  <!-- Retrospective: driven by `autopilot.retrospective_mode`. The external
       `bmad-retrospective` skill is NEVER invoked from autopilot (multi-persona
       discussion loop under some CLIs). -->

  <check if="{{retrospective_mode}} is auto">
    <action>Collect from `{status_file}` for epic `{{epic_id}}`: done stories `{ story-key, title, test_pass_count, patch_count }`, epic title, dates if present.</action>
    <action>Collect decision-log entries for epic `{{epic_id}}` (match `story` prefix `{{epic_id}}-` or `phase: autopilot:*` tagged to this epic). Identify open risks / carry-over notes from any story `notes`/`risks` fields or `workaround` decisions for this epic.</action>
    <action>Ensure `{implementation_artifacts}/retrospectives/` exists. Read template `{{project_root}}/_Sprintpilot/templates/epic-retrospective.md`, fill mustache placeholders, write to `{implementation_artifacts}/retrospectives/epic-{{epic_id}}-retrospective.md`.</action>
    <action>Update `{status_file}`: `epics.{{epic_id}}.status = done`, `.retrospective_path = <file>`, `.completed_at = {current_date}`.</action>
    <action>Append decision-log entry: `{ category: workaround, decision: "retrospective generated inline", rationale: "retrospective_mode=auto", impact: low, phase: autopilot:retrospective, story: "epic-{{epic_id}}" }`.</action>
    <action>Mark retrospective task → `completed`. Set `{{completed_skill}}` = `retrospective-auto`.</action>
  </check>

  <check if="{{retrospective_mode}} is stop">
    <action>Update `{state_file}`: `paused_at = epic-complete-awaiting-retrospective`, `paused_epic_id = {{epic_id}}`, `next_action = "run /bmad-retrospective interactively for epic {{epic_id}}, then re-run /sprint-autopilot-on"`.</action>
    <action>Append decision-log entry: `{ category: workaround, decision: "paused for interactive retrospective", rationale: "retrospective_mode=stop", impact: low, phase: autopilot:retrospective, story: "epic-{{epic_id}}" }`. Mark retrospective task → `completed`.</action>
    <action>Report: "Autopilot paused — epic {{epic_id}} complete, retrospective handed off. Run `/bmad-retrospective` interactively for epic {{epic_id}}, then re-run `/sprint-autopilot-on`. State saved to: {state_file}." Then STOP.</action>
  </check>

  <check if="{{retrospective_mode}} is skip">
    <action>Update `{status_file}`: `epics.{{epic_id}}.status = done`, `.retrospective_path = null`, `.retrospective_skipped = true`, `.completed_at = {current_date}`.</action>
    <action>Append decision-log entry: `{ category: workaround, decision: "retrospective skipped", rationale: "retrospective_mode=skip (NOT RECOMMENDED)", impact: medium, phase: autopilot:retrospective, story: "epic-{{epic_id}}" }`. Mark retrospective task → `completed`. Set `{{completed_skill}}` = `retrospective-skip`.</action>
  </check>

  <check if="{{git_enabled}}">
    <action>**Epic PR summary** — list all epic PR/MR URLs from `{status_file}` and report as "Epic complete — PR/MR summary: [list]. Ready to merge — review PRs and confirm when ready."</action>
    <check if="{{cleanup_on_merge}} is true">
      <action>**Cleanup worktrees** for completed stories. For each: if `.worktrees/{{story-key}}` exists, check cleanliness via `git -C .worktrees/{{story-key}} status --porcelain`. If clean → `git worktree remove` + `git worktree prune` and set `worktree_cleaned: true` in `{git_status_file}`. If dirty → warn and skip.</action>
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

<action>Update `{state_file}` with STATE_FIELDS.</action>

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

<action>Update `{state_file}` with STATE_FIELDS.</action>
<check if="{{coalesce_state_writes}} is true">
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/state-shard.js flush --story sprint --project-root "{{project_root}}"` — ignore failures.</action>
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/merge-shards.js --project-root "{{project_root}}"` — ignore failures.</action>
</check>

<!-- Phase-timing session snapshot (no-op if autopilot.phase_timings is false). -->
<action>Run: `node {{project_root}}/_Sprintpilot/scripts/summarize-timings.js --session-only --format md --quiet --project-root "{{project_root}}"` — ignore failures. The stdout line is the artifact path; include it in the checkpoint report if non-empty.</action>

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

<!-- PR 6 SPRINT-COMPLETE FLUSH + ARCHIVE (no-op if coalescing is off). -->
<check if="{{coalesce_state_writes}} is true">
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/state-shard.js flush --story sprint --project-root "{{project_root}}"` — ignore failures.</action>
  <action>Run: `node {{project_root}}/_Sprintpilot/scripts/merge-shards.js --archive --layer "sprint-complete-$(date -u +%Y%m%dT%H%M%SZ)" --project-root "{{project_root}}"` — ignore failures. --archive moves merged shards to .archive/layer-... so next sprint starts clean.</action>
</check>

<!-- Final phase-timing hotspot report (no-op if autopilot.phase_timings is false). -->
<action>Run: `node {{project_root}}/_Sprintpilot/scripts/summarize-timings.js --format md --quiet --project-root "{{project_root}}"` — ignore failures. The stdout line is the artifact path; include it in the sprint report if non-empty.</action>

<!-- Generate project documentation after sprint completion -->
<action>**Resolve stack** — set `{{stack}}` = `{ name, install_cmd, run_cmd, test_cmd }` using the first successful source:

  1. **`project-context.md`** (glob `**/project-context.md`, canonical `{output_folder}/project-context.md`) — extract from "Technology Stack & Versions" and any install/run/test subsections.
  2. **`architecture.md`** (`{planning_artifacts}/architecture.md`) — extract from "Tech Stack" / "Runtime" / "Build & Deploy" / "Commands" sections.
  3. **Manifest heuristics** — map manifest file → stack → idiomatic commands:

  | Manifest | Stack | install / run / test |
  |---|---|---|
  | `package.json` | Node/JS/TS | `<pm> install` / `<pm> run start\|dev\|serve` (or `node <bin>`) / `<pm> test` — `<pm>` = `pnpm`/`yarn`/`bun`/`npm` by lockfile |
  | `pyproject.toml`, `requirements.txt`, `setup.py` | Python | `pip install -r requirements.txt` (or `-e .`) / Django `python manage.py runserver` → Flask → FastAPI `uvicorn app:app` → `python main.py`/`app.py` / `pytest` |
  | `go.mod` | Go | `go mod download` / `go run .` (or `./cmd/<name>`) / `go test ./...` |
  | `Cargo.toml` | Rust | `cargo build` / `cargo run` (or `--bin <name>`) / `cargo test` |
  | `pom.xml` | Java/Kotlin (Maven) | `mvn install` / `mvn spring-boot:run` or `mvn exec:java` / `mvn test` |
  | `build.gradle(.kts)` | Java/Kotlin (Gradle) | `./gradlew build` / `./gradlew bootRun` or `run` / `./gradlew test` |
  | `Gemfile` | Ruby | `bundle install` / `rails server` or `bundle exec ruby <entry>` / `bundle exec rspec` |
  | `*.csproj`/`*.sln` | .NET | `dotnet restore` / `dotnet run` (or `--project`) / `dotnet test` |
  | `composer.json` | PHP | `composer install` / `php artisan serve` (Laravel) or `php -S localhost:8000 -t public` / `vendor/bin/phpunit` |
  | `mix.exs` | Elixir | `mix deps.get` / `mix phx.server` or `mix run --no-halt` / `mix test` |
  | (none of the above) | Explicit launcher | `./run.sh`/`./run_gui.sh`/`./start.sh`, `make run\|start\|dev`, `docker compose up`, `docker build` + `docker run` |

  4. **No match** — all fields `null`. Downstream omits the line; never guess.

  Set `{{launch_cmd}}` = `{{stack.run_cmd}}`.
  If `{{stack}}` came from (3) and `project-context.md` exists without stack info, log: "Consider running `bmad-generate-project-context` to capture stack commands."
</action>

<action>**Generate documentation** — invoke `bmad-document-project`. If unavailable or it fails, write a minimal README using `{{stack}}`: project name + description (from brief/PRD); install/run/test lines for each non-null `{{stack.*_cmd}}` (omit lines where null); architecture overview if `architecture.md` exists.</action>

<check if="{{git_enabled}}">
  <action>**Commit final artifacts + docs to main.**
  1. `git checkout -B {{base_branch}} origin/{{base_branch}}`
  2. `git add _bmad-output/ README.md docs/` (ignore missing-path errors)
  3. If `git diff --cached --quiet` exits non-zero: `git commit -m "docs: project documentation and final artifacts"` then `git push origin {{base_branch}}` (warn on push failure).
  </action>
</check>

<action>**Collect report data** from `{status_file}` (stories grouped by epic with titles, totals, final test count; PR/MR URLs, patch/dismissed counts per story if git_enabled) and `{decision_log_file}` (medium/high-impact decisions; counts of `review-accept`, `review-triage`, code-review rounds; per-story patches-applied / findings-dismissed).</action>

<check if="{{git_enabled}}">
  <action>**Cleanup remaining worktrees** (safety net): `git worktree list --porcelain` → for each non-main worktree: `git worktree remove <path> --force` then `git worktree prune` (log + continue on failure).</action>
  <!-- PR 10: restore main-repo gc.auto to its prior value. -->
  <action>**Restore main-repo gc.auto**:
  if `{{original_gc_auto_main}}` is "unset": `git config --local --unset gc.auto` (ignore failure — may already be unset).
  else: `git config --local gc.auto {{original_gc_auto_main}}`.
  </action>
  <action>Release lock: `node {{project_root}}/_Sprintpilot/scripts/lock.js release`</action>
</check>

<action>Delete `{state_file}` — sprint complete</action>
<action>Mark master task "Sprintpilot — Full Sprint Execution" → `completed`</action>

<action>Read template `{{project_root}}/_Sprintpilot/templates/sprint-report.txt`, fill mustache placeholders with the collected data, and print the result verbatim as the final message.</action>

</step>

</workflow>
