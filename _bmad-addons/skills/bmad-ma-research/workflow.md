# Multi-Agent Research

## Purpose

Fan out research across multiple topics in parallel. Each research agent gets a topic and type (technical/domain/market), uses WebSearch and WebFetch, and returns structured findings. Results are collected and synthesized.

---

## Step 1 — Gather Research Topics

<action>Get research topics from user or from the current workflow context.

Expected input format:
```
Topics:
1. [type: technical] How does Prisma handle migrations compared to TypeORM?
2. [type: domain] Healthcare HIPAA compliance requirements for SaaS
3. [type: market] Competitor analysis for API gateway products
```

If no topics provided, ask the user. Each topic needs:
- **Topic text** — what to research
- **Type** — `technical` (implementation approaches), `domain` (industry knowledge), or `market` (competitive landscape)
</action>

<action>Set `{{topics}}` = list of topics with types</action>

---

## Step 2 — Launch Research Agents in Parallel

<critical>
Launch ALL agents in a single message.
Max parallel agents: 3 (from config). If more than 3 topics, batch into rounds.
Each agent gets the topic, type, and instructions for that research type.
</critical>

For each topic, launch:
```
Agent(
  description: "Research: {topic_summary}",
  prompt: "You are a research agent. Your task:

  **Topic**: {topic_text}
  **Type**: {type}

  ## Instructions

  Use WebSearch to find current, authoritative information.
  Use WebFetch to read promising results in detail.

  ### For 'technical' topics:
  - Find official documentation, blog posts, benchmarks
  - Compare approaches with pros/cons
  - Include code examples if relevant
  - Cite sources with URLs

  ### For 'domain' topics:
  - Find regulatory documents, industry standards, expert analyses
  - Identify key terminology and requirements
  - Note recent changes or trends
  - Cite authoritative sources

  ### For 'market' topics:
  - Identify competitors and alternatives
  - Compare features, pricing, market position
  - Note trends and market direction
  - Cite data sources

  ## Output Format

  ```markdown
  ## Research: {topic_summary}

  ### Key Findings
  1. ...
  2. ...
  3. ...

  ### Details
  [Structured analysis based on type]

  ### Sources
  - [Title](URL) — brief note on relevance
  ```

  Cap response at 2000 tokens. Be concise and factual."
)
```

---

## Step 3 — Collect and Synthesize

<action>Collect all agent results.</action>

<action>Produce unified research report:

```markdown
# Research Report

## Topics Researched
| # | Type | Topic | Status |
|---|------|-------|--------|
| 1 | technical | ... | complete |
| 2 | domain | ... | complete |
| 3 | market | ... | complete |

## Findings

### Topic 1: {title}
[Agent 1's findings]

### Topic 2: {title}
[Agent 2's findings]

### Topic 3: {title}
[Agent 3's findings]

## Cross-Topic Insights
[Any connections or conflicts between findings across topics]

## Sources
[Consolidated list of all sources cited]
```
</action>

<action>If this was triggered by a BMAD workflow (e.g., during architecture or PRD creation), save to `{planning_artifacts}/research-{topic-slug}.md`</action>
