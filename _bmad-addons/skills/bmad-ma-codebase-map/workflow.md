# Multi-Agent Codebase Map

## Purpose

Analyze an existing codebase across 5 dimensions in parallel. Produces structured, evidence-based reports with exact file path citations, optimized for consumption by BMAD planning agents.

## Output Location

All outputs go to `{project-root}/_bmad-output/codebase-analysis/`.

## Relationship to bmad-document-project

Complementary, not a replacement. `bmad-document-project` generates comprehensive human-readable docs. This skill generates structured analysis optimized for downstream LLM consumption. Run this first, then `bmad-document-project` for full documentation.

---

## Step 1 — Prepare

<action>Create output directory: `mkdir -p _bmad-output/codebase-analysis`</action>
<action>Determine project root absolute path: `{{project_root}}`</action>

---

## Step 2 — Launch 5 Analysis Agents in Parallel

Launch ALL FIVE agents in a **single message** using the Agent tool.

<critical>
All 5 Agent calls MUST be in the same message to run in parallel.
Each agent writes its output file directly.
Each agent must cite exact file paths for every finding.
</critical>

### Agent 1: Stack Analyzer

```
Agent(
  description: "Technology stack analysis",
  prompt: <read from ./agents/stack-analyzer.md, set project_root={{project_root}}, output_file={{project_root}}/_bmad-output/codebase-analysis/STACK.md>
)
```

### Agent 2: Architecture Mapper

```
Agent(
  description: "Architecture pattern analysis",
  prompt: <read from ./agents/architecture-mapper.md, set project_root and output_file>
)
```

### Agent 3: Quality Assessor

```
Agent(
  description: "Code quality assessment",
  prompt: <read from ./agents/quality-assessor.md, set project_root and output_file>
)
```

### Agent 4: Concerns Hunter

```
Agent(
  description: "Tech debt and concerns scan",
  prompt: <read from ./agents/concerns-hunter.md, set project_root and output_file>
)
```

### Agent 5: Integration Mapper

```
Agent(
  description: "External integration mapping",
  prompt: <read from ./agents/integration-mapper.md, set project_root and output_file>
)
```

---

## Step 3 — Collect and Verify

<action>Verify all 5 output files exist in `_bmad-output/codebase-analysis/`:
- STACK.md
- ARCHITECTURE.md
- QUALITY.md
- CONCERNS.md
- INTEGRATIONS.md
</action>

<action>If any agent failed, log which one and note the gap. Do not re-run — present partial results.</action>

---

## Step 4 — Summary

<action>Read all 5 output files and produce a brief summary:

```markdown
## Codebase Analysis Complete

| Dimension | File | Key Findings |
|-----------|------|-------------|
| Stack | STACK.md | {languages}, {frameworks}, {package count} |
| Architecture | ARCHITECTURE.md | {pattern}, {module count} |
| Quality | QUALITY.md | {test coverage}, {lint status} |
| Concerns | CONCERNS.md | {critical count}, {high count} |
| Integrations | INTEGRATIONS.md | {external service count} |

Outputs: `_bmad-output/codebase-analysis/`

Recommended next steps:
- `bmad-ma-assess` — deep-dive tech debt and migration assessment
- `bmad-ma-reverse-architect` — extract formal architecture document
- `bmad-create-prd` — informed by codebase analysis
```
</action>
