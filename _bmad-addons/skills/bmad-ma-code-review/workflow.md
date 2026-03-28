# Multi-Agent Code Review

## Purpose

Perform a thorough code review using 3 parallel subagents, each with a different review lens. Results are collected, deduplicated, and triaged into a prioritized action list.

## When to Use

Use this instead of stock `bmad-code-review` when you want deeper coverage. The autopilot can be configured to call this automatically.

---

## Step 1 — Gather Context

<action>Identify the story being reviewed from sprint-status.yaml or user input.</action>
<action>Generate the diff to review:
```bash
git diff HEAD~1 --unified=5
```
If the diff exceeds 3000 lines, summarize by file and only pass relevant sections to agents.
Save full diff to `review-diff.txt` for agent reference.
</action>
<action>Read the story file to extract acceptance criteria.</action>
<action>Set `{{diff_file}}` = path to review-diff.txt</action>
<action>Set `{{story_file}}` = path to story file</action>

---

## Step 2 — Launch 3 Review Agents in Parallel

Launch ALL THREE agents in a **single message** using the Agent tool. Each agent gets its own inlined prompt (not a Skill reference).

<critical>
All 3 Agent calls MUST be in the same message to run in parallel.
Each agent's result is capped at ~2000 tokens via structured output instructions.
</critical>

### Agent 1: Blind Hunter (Adversarial Review)

```
Agent(
  description: "Blind adversarial code review",
  prompt: <read from ./agents/blind-hunter.md, append diff content or diff_file path>
)
```

### Agent 2: Edge Case Hunter

```
Agent(
  description: "Edge case analysis",
  prompt: <read from ./agents/edge-case-hunter.md, append diff content or diff_file path>
)
```

### Agent 3: Acceptance Auditor

```
Agent(
  description: "Acceptance criteria audit",
  prompt: <read from ./agents/acceptance-auditor.md, append diff content + story file content>
)
```

---

## Step 3 — Triage Results

<action>Collect all 3 agent results.</action>

<action>For each finding, classify:
- **PATCH** — concrete code fix needed, actionable
- **WARN** — valid concern but no code change needed (document for awareness)
- **DISMISS** — false positive, not applicable, or already handled

Deduplication rules:
- Same file + same line range + same concern → merge into one finding
- **Contradictory findings** (Agent A says "add check", Agent B says "remove check"):
  → If Acceptance Auditor cites an AC → Acceptance Auditor wins
  → Otherwise → classify as `decision_needed` and flag for user
</action>

<action>Produce the triage report:

```markdown
## Code Review — Triage Report

### PATCH (apply these)
1. **[P1]** {title} — {file}:{line} — {description} — Source: {agent}
2. **[P2]** ...

### WARN (acknowledge, no code change)
1. **[W1]** {title} — {description} — Source: {agent}

### DISMISSED
1. **[D1]** {reason} — Source: {agent}

### DECISION NEEDED (contradictory or ambiguous)
1. **[DN1]** {description} — Agent A says: ... / Agent B says: ...
```
</action>

---

## Step 4 — Output

<action>Present the triage report to the caller (autopilot or user).</action>
<action>If running under autopilot: the autopilot will auto-apply all PATCH findings and commit each one.</action>
<action>If running manually: present findings and ask user which to apply.</action>

<action>Suggest next step: "Apply patches, then run full test suite."</action>
