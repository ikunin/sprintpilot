---
name: sprintpilot-sprint-progress
description: 'Synthesize current sprint execution progress with LLM-layered judgment. Reads sprint-plan.yaml, sprint-status.yaml, and the autopilot ledger via `autopilot progress`; highlights stalls, repeated verify failures, retry loops, and stuck phases; suggests the next action (continue, narrow to a specific story, reorder, replan, abort). Use when you want a quick health check between autopilot sessions without scrolling through the raw ledger.'
---

## STOP — read this entire file before doing anything

This skill is a **read-only diagnostic**. It does not change sprint-plan.yaml,
sprint-status.yaml, or any persisted autopilot state. The goal is to produce
a concise human-readable summary of where execution stands and what (if
anything) the user should do about it.

Follow **`./workflow.md`** verbatim. The three steps it lists are:

1. Collect the structured snapshot via `autopilot progress --json`.
2. Pull recent ledger entries for halt / verify / step context.
3. Synthesize a brief progress report with LLM judgment + one
   recommended next action.

### Never improvise

- **No file writes.** This skill is observational. If the user wants to
  reorder, add stories, mark something skipped, or replan — point them
  at the appropriate user_input command or `/sprintpilot-plan-sprint`.
  Don't try to fix things from this skill.
- **No state interpretation beyond what's in the ledger.** Don't
  speculate about why a verify failed — just report what the ledger
  says and recommend the user look at the relevant file.
- **No long-form output by default.** Default mode is ≤15 lines. If
  the user asks for more detail, narrow to a story and read its
  recent step events.

### When to invoke

- Between autopilot sessions to check whether anything halted that
  needs intervention.
- When you (the LLM) just finished a long batch of stories and want
  to know if anything's stuck before suggesting next moves.
- When the user asks "how's the sprint going?" / "where are we?" /
  "is autopilot stuck?".

### When NOT to invoke

- For machine-readable output: call
  `node _Sprintpilot/bin/autopilot.js progress --json` directly. This
  skill adds LLM synthesis on top — pure JSON consumers don't need it.
- For full sprint reports: that's `bmad-sprint-status` (BMad-native,
  reads sprint-status.yaml only).
- For build / deploy / CI status: not this skill's domain.

---

Follow the instructions in ./workflow.md.
