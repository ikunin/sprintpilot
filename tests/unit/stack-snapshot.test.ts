import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import stackSnapshot from '../../_Sprintpilot/scripts/stack-snapshot.js';

const { statusForStory } = stackSnapshot as {
  statusForStory: (sprintStatusText: string | null, storyKey: string) => string;
};

describe('statusForStory', () => {
  it('returns unknown when sprint-status missing', () => {
    expect(statusForStory(null, 'S1')).toBe('unknown');
  });

  it('extracts a story status from inline YAML', () => {
    const yaml = ['stories:', '  S1: done', '  S2: in_progress', '  S3: backlog'].join('\n');
    expect(statusForStory(yaml, 'S1')).toBe('done');
    expect(statusForStory(yaml, 'S2')).toBe('in_progress');
  });

  it('returns unknown when story key not found', () => {
    expect(statusForStory('stories:\n  S2: done\n', 'S1')).toBe('unknown');
  });
});
