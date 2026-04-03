# Multi-Agent Party Mode

## Purpose

Run real parallel multi-persona discussions. Instead of sequentially role-playing each persona (as stock `bmad-party-mode` does), this launches 2-3 Agent subagents simultaneously, each embodying a different BMAD persona. Results are collected and presented as a discussion round.

---

## Step 1 — Setup

<action>Get from user or context:
- **Topic/Question**: what to discuss
- **Personas**: which BMAD personas to include (2-3 per round)
  Available: analyst, architect, pm, dev, qa, ux-designer, tech-writer, sm
- **Context files**: any project artifacts to provide as context (PRD, architecture, etc.)
- **Rounds**: how many discussion rounds (default: 2)

If not specified, recommend a relevant set based on the topic:
- Architecture decisions → architect, dev, qa
- Product direction → pm, analyst, ux-designer
- Implementation approach → dev, architect, qa
- Process/workflow → sm, pm, dev
</action>

---

## Step 2 — Load Persona Definitions

<action>For each selected persona, read the agent definition from BMAD:
- `{project-root}/_bmad/_config/agents/` — look for persona YAML files
- Or look in the installed skills directory for `bmad-agent-{persona}/SKILL.md`

Extract the persona's:
- Role description
- Expertise areas
- Communication style
- Key concerns/priorities
</action>

---

## Step 3 — Run Discussion Rounds

For each round (1 to {{num_rounds}}):

<critical>Launch ALL persona agents for this round in a single message.</critical>

For each persona in this round:
```
Agent(
  description: "{persona_name} perspective on {topic}",
  prompt: "You are the {persona_name} on a BMAD development team.

  ## Your Role
  {persona_description}

  ## Your Priorities
  {persona_priorities}

  ## Discussion Topic
  {topic}

  ## Context
  {project_context_files_content}

  ## Previous Round Discussion
  {previous_round_responses — empty for round 1}

  ## Instructions

  Respond to the topic from your persona's perspective.
  - State your position clearly
  - Raise concerns specific to your role
  - Propose concrete actions
  - If responding to previous round: agree, disagree, or build on other personas' points
  - Be direct and specific, not generic

  Cap response at 1000 tokens."
)
```

<action>Collect all responses for this round.</action>

<action>Present the round:

```markdown
## Round {{round_number}}

### {Persona 1 Name} ({role})
{response}

### {Persona 2 Name} ({role})
{response}

### {Persona 3 Name} ({role})
{response}
```
</action>

<action>For subsequent rounds, include previous round responses as context so personas can respond to each other.</action>

---

## Step 4 — Synthesis

After all rounds complete:

<action>Produce a synthesis:

```markdown
## Discussion Summary

### Topic
{topic}

### Participants
{persona list with roles}

### Points of Agreement
- ...

### Points of Disagreement
- {persona A} vs {persona B}: ...
  Resolution suggestion: ...

### Action Items
1. [Owner: {persona}] {action}
2. ...

### Open Questions
- ...

### Recommendation
[Based on the discussion, what is the recommended path forward?]
```
</action>

<action>Ask user: "Continue with another topic, or apply these insights to the current workflow?"</action>
