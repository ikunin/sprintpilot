import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import autopilot from '../../_Sprintpilot/bin/autopilot.js';

const formatNextStorySummary = autopilot.formatNextStorySummary as (
  runtime: unknown,
  action?: unknown,
  queue?: unknown,
) => string | null;

describe('formatNextStorySummary', () => {
  it('returns null for null runtime', () => {
    expect(formatNextStorySummary(null)).toBeNull();
  });

  it('returns null when there is no story_key and no actionable skill', () => {
    expect(formatNextStorySummary({ phase: 'create_story' })).toBeNull();
  });

  it('names the operation when no story is resolved yet but a skill will run (fresh CREATE_STORY boot)', () => {
    const line = formatNextStorySummary(
      { phase: 'create_story' },
      { type: 'invoke_skill', skill: 'bmad-create-story' },
    );
    expect(line).toBe('NEXT: bmad-create-story · step create_story');
  });

  it('renders NEXT with key + step + bare epic when no queue is given', () => {
    const line = formatNextStorySummary({
      story_key: '21-1-http-mcp-wrapper-for-memory',
      phase: 'create_story',
      current_epic: '21',
    });
    expect(line).toBe('NEXT: 21-1-http-mcp-wrapper-for-memory · step create_story · epic 21');
  });

  it('renders the in-epic position when the ordered queue is provided', () => {
    const queue = [
      '21-1-http-mcp-wrapper-for-memory',
      '21-2-user-active-project-state',
      '21-3-user-preferences-workspace-and-verbosity',
    ];
    const line = formatNextStorySummary(
      { story_key: '21-1-http-mcp-wrapper-for-memory', phase: 'create_story', current_epic: '21' },
      null,
      queue,
    );
    expect(line).toBe(
      'NEXT: 21-1-http-mcp-wrapper-for-memory · step create_story · #1 of 3 in epic 21',
    );
  });

  it('counts only same-epic entries for the position denominator', () => {
    // A mixed queue (epic 21 head + leftover other-epic stories) should not
    // inflate the epic-21 total.
    const queue = [
      '21-1-http-mcp-wrapper-for-memory',
      '21-2-user-active-project-state',
      't-28-memory-export-and-import',
      '6-7-family-newsletter-digest',
    ];
    const line = formatNextStorySummary(
      { story_key: '21-1-http-mcp-wrapper-for-memory', phase: 'create_story', current_epic: '21' },
      null,
      queue,
    );
    expect(line).toBe(
      'NEXT: 21-1-http-mcp-wrapper-for-memory · step create_story · #1 of 2 in epic 21',
    );
  });

  it('derives the epic from the key when current_epic is absent', () => {
    const line = formatNextStorySummary({
      story_key: '21-4-paperclip-activity-stream-poller',
      phase: 'dev_red',
    });
    expect(line).toBe('NEXT: 21-4-paperclip-activity-stream-poller · step dev_red · epic 21');
  });

  it('reports a halt action as PAUSED with its reason', () => {
    const line = formatNextStorySummary(
      { story_key: '21-1-x', phase: 'create_story', current_epic: '21' },
      { type: 'halt', reason: 'phase_timeout_exceeded' },
    );
    expect(line).toBe('PAUSED: phase_timeout_exceeded');
  });

  it('reports a user_prompt action as PAUSED with the first prompt line', () => {
    const line = formatNextStorySummary(
      { story_key: '21-1-x', phase: 'create_story', current_epic: '21' },
      {
        type: 'user_prompt',
        prompt: 'Sprint plan complete. All 18 planned stories are done.\nRun…',
      },
    );
    expect(line).toBe('PAUSED: Sprint plan complete. All 18 planned stories are done.');
  });

  it('reports sprint completion explicitly', () => {
    const line = formatNextStorySummary({
      story_key: null,
      sprint_is_complete: true,
    });
    expect(line).toBe('Sprint complete — no stories remain to process.');
  });

  it('handles a step-less runtime (key + epic only)', () => {
    const line = formatNextStorySummary({
      story_key: '21-1-x',
      current_epic: '21',
    });
    expect(line).toBe('NEXT: 21-1-x · epic 21');
  });
});
