---
name: sprintpilot-dependency-graph
description: 'Render the sprint dependency graph from sprint-plan.yaml in a chosen format. Accepts mermaid (default), graphviz, text (topological tree), layers (parallel-eligible groups), or json (raw nodes + edges). Use when you want to visualize or programmatically inspect the DAG without manually calling resolve-dag.js. Optionally narrow to a single epic with an epic argument.'
---

## STOP — read this entire file before doing anything

This skill is a **read-only renderer**. It does not modify `sprint-plan.yaml`,
trigger LLM inference, or change autopilot state. The goal is to produce a
visualization or structured dump of the existing dependency graph.

Follow **`./workflow.md`** verbatim. The 4-step flow:

1. Parse the user's invocation for a format + optional epic scope.
2. Resolve format ambiguity by asking the user (only when no argument
   was supplied).
3. Shell out to `resolve-dag.js` with the resolved flags.
4. Render the output inline (mermaid block) or report the written
   file path (graphviz / mermaid-to-file).

### Never improvise

- **No file edits to `sprint-plan.yaml`.** If the plan is missing or
  empty, point the user at `/sprintpilot-plan-sprint` — do NOT try to
  build a plan from this skill.
- **No re-inference.** Dependency inference lives in
  `/sprintpilot-plan-sprint`. This skill renders what's already there.
- **No format substitution.** If the user explicitly asks for graphviz
  and `dot` isn't installed, the underlying script auto-falls-back to
  mermaid with a stderr notice — surface that fallback clearly so the
  user knows their requested format wasn't honored.

### Invocation patterns

| User input | Behavior |
|---|---|
| `/sprintpilot-dependency-graph` | Ask: mermaid / graphviz / text / layers / json |
| `/sprintpilot-dependency-graph mermaid` | Render mermaid; inline the diagram in chat |
| `/sprintpilot-dependency-graph graphviz` | Write .dot file; report path |
| `/sprintpilot-dependency-graph text` | Topological-tree to chat, no file |
| `/sprintpilot-dependency-graph layers` | JSON [[layer1], [layer2], ...] to chat |
| `/sprintpilot-dependency-graph json` | JSON `{nodes, edges, epic}` to chat |
| `/sprintpilot-dependency-graph mermaid epic 1` | Per-epic scope (cross-epic edges excluded) |
| `/sprintpilot-dependency-graph mermaid --output dag.mmd` | Custom output path |

Natural-language synonyms (parse loosely):
- "show me the dependency graph" → ask for format
- "render the dag as mermaid" → mermaid
- "dot graph" / "graphviz output" → graphviz
- "layers" / "parallel groups" → layers
- "tree" / "text" / "plain" → text

### When NOT to invoke

- You want to BUILD or RE-INFER the graph → `/sprintpilot-plan-sprint`.
- You want sprint progress / health → `/sprintpilot-sprint-progress`.
- You want the BMad-native sprint-status report → `bmad-sprint-status`.
- The plan file is absent → halt politely and point the user at the
  planning skill instead of rendering an empty graph.

---

Follow the instructions in ./workflow.md.
