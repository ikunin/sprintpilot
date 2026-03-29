# Multi-Agent Reverse Architecture Extraction

## Purpose

Extract a formal architecture document from existing code (bottom-up). Produces output compatible with BMAD's `bmad-create-architecture` format, enabling brownfield projects to feed into `bmad-create-epics-and-stories` without writing an architecture doc from scratch.

## Prerequisites

Run `bmad-ma-codebase-map` first. This skill reads from `_bmad-output/codebase-analysis/`.

## Output

`{planning_artifacts}/architecture.md` — BMAD-compatible architecture document.

---

## Step 1 — Load Context

<action>Read codebase analysis files:
- `_bmad-output/codebase-analysis/stack-analysis.md`
- `_bmad-output/codebase-analysis/architecture-analysis.md`
- `_bmad-output/codebase-analysis/integrations-analysis.md`
These provide the foundation for deeper extraction.
</action>

---

## Step 2 — Launch 3 Extraction Agents in Parallel

<critical>All 3 Agent calls in a single message.</critical>

### Agent 1: Component Mapper

```
Agent(
  description: "Module boundary and API extraction",
  prompt: <read ./agents/component-mapper.md, append architecture-analysis.md content>
)
```
Focus: module boundaries, public APIs, internal dependency graph, component contracts.

### Agent 2: Data Flow Tracer

```
Agent(
  description: "Request path and data flow tracing",
  prompt: <read ./agents/data-flow-tracer.md, append architecture-analysis.md + integrations-analysis.md content>
)
```
Focus: request lifecycle, data transformations, state management, async flows.

### Agent 3: Pattern Extractor

```
Agent(
  description: "Design pattern and convention extraction",
  prompt: <read ./agents/pattern-extractor.md, append architecture-analysis.md + stack-analysis.md content>
)
```
Focus: design patterns in use, naming conventions, error handling strategy, testing patterns.

---

## Step 3 — Synthesize into BMAD Architecture Document

<action>Collect all 3 agent results and merge into a single architecture document following BMAD's format:

```markdown
# Architecture Document

## Technology Stack
[From stack-analysis.md — summarize key decisions]

## System Architecture
[Overall pattern: monolith/microservices/serverless/hybrid]

### Component Diagram
[From Component Mapper — describe modules and their relationships]
[Include a Mermaid diagram if possible]

### Data Flow
[From Data Flow Tracer — primary request/data flows]

### Integration Architecture
[From integrations-analysis.md — external service connections]

## Component Details

### [Component Name]
- **Path**: ...
- **Responsibility**: ...
- **Public API**: ...
- **Dependencies**: ...
- **Data model**: ...

[Repeat for each major component]

## Design Decisions (Extracted)
[From Pattern Extractor — document observed patterns as architectural decisions]

| Decision | Pattern | Where | Rationale (inferred) |
|----------|---------|-------|---------------------|
| ... | ... | ... | ... |

## Conventions and Standards
[From Pattern Extractor]
- Naming: ...
- Error handling: ...
- Testing: ...
- Logging: ...

## Known Limitations
[From codebase analysis — things that should be addressed]
```
</action>

<action>Write to `{planning_artifacts}/architecture.md`</action>

<action>Report: "Architecture extracted from code. This document can be used as input to `bmad-create-epics-and-stories` for planning improvements."</action>
