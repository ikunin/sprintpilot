import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import autopilot from '../../_Sprintpilot/bin/autopilot.js';

const inferFocusEpicsFromStoryKeys = autopilot.inferFocusEpicsFromStoryKeys as (
  keys: unknown,
) => string[] | null;

describe('inferFocusEpicsFromStoryKeys', () => {
  it('returns null for null / undefined / empty input', () => {
    expect(inferFocusEpicsFromStoryKeys(null)).toBeNull();
    expect(inferFocusEpicsFromStoryKeys(undefined)).toBeNull();
    expect(inferFocusEpicsFromStoryKeys([])).toBeNull();
  });

  it('returns null for non-array input', () => {
    expect(inferFocusEpicsFromStoryKeys('21-1-foo' as unknown)).toBeNull();
    expect(inferFocusEpicsFromStoryKeys({ keys: ['21-1'] } as unknown)).toBeNull();
  });

  it('returns the single epic when all keys belong to one numeric epic', () => {
    expect(inferFocusEpicsFromStoryKeys(['21-1-foo', '21-2-bar', '21-3-baz'])).toEqual(['21']);
  });

  it('returns the single epic for alphabetic / "t" epics', () => {
    expect(inferFocusEpicsFromStoryKeys(['t-28-memory-export', 't-29-foo'])).toEqual(['t']);
  });

  it('returns null when keys span multiple epics', () => {
    expect(inferFocusEpicsFromStoryKeys(['21-1-foo', '20-2-bar'])).toBeNull();
    expect(inferFocusEpicsFromStoryKeys(['21-1-foo', 't-28-bar'])).toBeNull();
  });

  it('normalizes epic-marker keys to their bare epic id', () => {
    // A mix of epic-21, epic-21-retrospective, and stories from epic 21
    // still counts as single-epic focus.
    expect(
      inferFocusEpicsFromStoryKeys(['epic-21', 'epic-21-retrospective', '21-1-foo']),
    ).toEqual(['21']);
  });

  it('returns null when epic markers span multiple epics', () => {
    expect(inferFocusEpicsFromStoryKeys(['epic-21', 'epic-20-retrospective'])).toBeNull();
  });

  it('returns null when any key is unparseable', () => {
    expect(inferFocusEpicsFromStoryKeys(['21-1-foo', 'nodash'])).toBeNull();
    expect(inferFocusEpicsFromStoryKeys(['21-1-foo', ''])).toEqual(['21']); // empty entries are skipped, not poisoning
    expect(inferFocusEpicsFromStoryKeys(['21-1-foo', null as unknown as string])).toEqual(['21']);
  });
});
