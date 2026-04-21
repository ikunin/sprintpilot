# Epic {{epic_id}} — {{epic_title}} — Retrospective

**Completed:** {current_date}
**Stories done:** {{n_done}}/{{n_total}}

## Stories
{{#each stories}}
- **{{story-key}}** — {{title}}
  - Tests: {{test_pass_count}}
  - Patches applied: {{patch_count}}
{{/each}}

## Key decisions
{{#each decisions}}
- [{{impact}}] {{category}}: {{decision}} — {{rationale}}
{{/each}}

## Risks carried forward
{{#each open_risks}}
- {{risk}}
{{/each}}

## Notes
Generated inline by Sprintpilot autopilot per `autopilot.retrospective_mode: auto`.
