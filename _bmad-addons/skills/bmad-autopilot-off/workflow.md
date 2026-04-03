# BMAD Autopilot — OFF (Enhanced with Git Status)

## Purpose

Disengage autopilot mode. Produce a complete status report including git branch/PR status, release the autopilot lock, and consult `bmad-help` for the exact next recommended step.

---

## INITIALIZATION

Load config: `{project-root}/_bmad/bmm/config.yaml`

Resolve:
- `implementation_artifacts`
- `status_file` = `{implementation_artifacts}/sprint-status.yaml` (BMAD-owned, read only)
- `git_status_file` = `{implementation_artifacts}/git-status.yaml` (addon-owned git fields)
- `decision_log_file` = `{implementation_artifacts}/decision-log.yaml`
- `planning_artifacts`
- `project_root` = absolute path of current working directory

### Git integration check

<action>Check if `{project-root}/_bmad-addons/manifest.yaml` exists</action>
<check if="manifest exists">
  <action>Read manifest → set `{{git_enabled}}` from `git.enabled`</action>
</check>
<check if="manifest does NOT exist">
  <action>Set `{{git_enabled}}` = false</action>
</check>

---

## EXECUTION

### Step 1 — Exit worktree if active

<check if="current working directory appears to be inside a worktree (check if `.worktrees/` is in the path or run `git rev-parse --show-toplevel` and compare to project_root)">
  <action>Commit any uncommitted work if possible</action>
  <action>`cd` to project root — preserve worktree for later resume</action>
  <action>Log: "Exited worktree, returned to project root"</action>
</check>

### Step 2 — Load sprint state

Read `{status_file}` fully.

If `{status_file}` does not exist:
> "No sprint-status.yaml found. Run `/bmad-sprint-planning` first, or `/bmad-autopilot-on` to start from the beginning."
> Stop.

### Step 3 — Summarize completed and in-progress work

Scan all entries in sprint-status:
- Count stories with status `done` — list them grouped by epic
- Find the first story that is `in-progress` or `ready-for-dev` — this is the current position
- Count remaining stories not yet `done`

### Step 4 — Collect git status (if enabled)

<check if="{{git_enabled}}">
  <action>Read `{git_status_file}` (addon's git-status.yaml) if it exists</action>
  <action>Extract `git_integration` block (platform, base_branch)</action>
  <action>For each story in `stories:` section:
    - Note `branch`, `push_status`, `pr_url`, `worktree_cleaned`
  </action>
  <action>Check for active worktrees: `git worktree list --porcelain 2>/dev/null`</action>
  <action>Check current branch: `git branch --show-current 2>/dev/null`</action>
</check>

### Step 5 — Consult bmad-help for next action

Invoke `bmad-help` with the question: "Where are we in the sprint and what is the next required step?"

Extract the recommended next skill and any important context.

### Step 6 — Release lock

<check if="{{git_enabled}}">
  <action>Release lock: `bash {{project_root}}/_bmad-addons/scripts/lock.sh release`</action>
</check>

### Step 7 — Collect decision log

<action>Read `{decision_log_file}` if it exists</action>
<action>Collect:
  - All decisions with impact `medium` or `high`
  - Count of `review-accept` entries (patches applied)
  - Count of `review-triage` entries (findings dismissed)
  - Per-story summary: patches applied and findings dismissed
</action>

### Step 8 — Produce status report

Output to user (use exact format):

```
╔═══════════════════════════════════════════════════════════════╗
║               BMAD AUTOPILOT — STATUS REPORT                  ║
╚═══════════════════════════════════════════════════════════════╝

SUMMARY
  Stories completed : {{done_count}}/{{total_stories}}
  Epics completed   : {{done_epics}}/{{total_epics}}
{{#if git_enabled}}
  Platform          : {{platform}}
{{/if}}

STORIES
{{#each epic}}
  Epic {{epic_number}}: {{epic_title}}
  {{#each stories}}
  {{#if done}}✓{{else}}{{#if in_progress}}▶{{else}}·{{/if}}{{/if}} {{story-key}}{{#if done}}{{#if pr_url}}  PR: {{pr_url}}{{/if}}{{/if}}{{#if in_progress}} ← current{{/if}}
  {{/each}}
{{/each}}

{{#if medium_high_decisions}}
DECISIONS REQUIRING REVIEW (high/medium impact)
{{#each medium_high_decisions}}
  #{{id}}  [{{impact}}] {{story}} / {{phase}}
      {{decision}}
      → {{rationale}}
{{/each}}

  Full log: {decision_log_file}
{{/if}}

{{#if has_review_data}}
REVIEW FINDINGS APPLIED
  Patches applied    : {{total_patches}}
  Findings dismissed : {{total_dismissed}}

CODE REVIEW SUMMARY (per story)
{{#each reviewed_stories}}
  {{story-key}} : {{patches_applied}} patches applied, {{findings_dismissed}} dismissed
{{/each}}
{{/if}}

{{#if git_enabled}}
GIT STATUS
{{#each stories_with_git_fields}}
  {{story-key}}: branch={{branch}} push={{push_status}} {{#if pr_url}}PR: {{pr_url}}{{/if}}
{{/each}}
  Active worktrees: {{worktree_count}}
  Lock: released
{{/if}}

NEXT REQUIRED STEP (from bmad-help)
  {{next_skill_name}} — {{next_skill_description}}

WHAT TO DO NEXT
  1. Review decisions marked medium/high above (if any)
  2. TO RESUME AUTOPILOT:  /bmad-autopilot-on
  3. TO CONTINUE MANUALLY: /{{next-skill-name}}
```
