# Multi-Agent Assessment

## Purpose

Deep-dive assessment of tech debt, dependency health, and migration paths. Runs after `bmad-ma-codebase-map` and consumes its outputs. Produces actionable, prioritized findings with effort estimates.

## Prerequisites

Run `bmad-ma-codebase-map` first. This skill reads from `{output_folder}/codebase-analysis/`.

## Output Location

`{output_folder}/codebase-analysis/brownfield-assessment.md`

---

## Step 1 — Verify Prerequisites

<action>Check that codebase analysis outputs exist:
- `{output_folder}/codebase-analysis/stack-analysis.md`
- `{output_folder}/codebase-analysis/concerns-analysis.md`
- `{output_folder}/codebase-analysis/quality-analysis.md`
If missing, suggest running `bmad-ma-codebase-map` first.
</action>

<action>Read all available analysis files to pass as context to agents.</action>

---

## Step 2 — Launch 3 Assessment Agents in Parallel

<critical>
All 3 Agent calls MUST be in the same message.
Each agent receives the codebase analysis outputs as context.
Each agent has Bash access for running audit tools.
</critical>

### Agent 1: Dependency Auditor

```
Agent(
  description: "Dependency audit and vulnerability scan",
  prompt: <read from ./agents/dependency-auditor.md, append stack-analysis.md content>
)
```

### Agent 2: Debt Classifier

```
Agent(
  description: "Tech debt classification and prioritization",
  prompt: <read from ./agents/debt-classifier.md, append concerns-analysis.md content>
)
```

### Agent 3: Migration Analyzer

```
Agent(
  description: "Framework upgrade and migration path analysis",
  prompt: <read from ./agents/migration-analyzer.md, append stack-analysis.md + concerns-analysis.md content>
)
```

---

## Step 3 — Synthesize

<action>Collect all 3 agent results.</action>

<action>Produce unified `brownfield-assessment.md`:

```markdown
# Brownfield Assessment

## Executive Summary
[2-3 sentences: overall health, top risks, recommended action]

## Priority Matrix

| ID | Category | Severity | Confidence | Effort | Title |
|----|----------|----------|------------|--------|-------|
| DEBT-001 | ... | Critical/High/Med/Low | High/Med/Low | S/M/L/XL | ... |

## Detailed Findings

### [DEBT-001] Title
- **Category**: Framework upgrade / Dependency / Security / Code quality
- **Severity**: Critical
- **Confidence**: High (evidence: ...)
- **Effort**: L (2-3 stories)
- **Evidence**:
  - `file:line` — description
- **Migration path**: step-by-step
- **Blocked by**: None / DEBT-XXX
- **Blocks**: DEBT-XXX

### [DEBT-002] ...

## Recommended Sprint Stories
[For top-priority findings, suggest story titles and scope]

## Migration Roadmap
[Phased plan if major migrations are needed]
```
</action>

<action>Write to `{output_folder}/codebase-analysis/brownfield-assessment.md`</action>

<action>Suggest next steps:
- `bmad-ma-reverse-architect` — extract architecture from code
- `bmad-ma-migrate` — detailed migration planning (if major upgrades needed)
- `bmad-sprint-planning` — plan stories from assessment findings
</action>
