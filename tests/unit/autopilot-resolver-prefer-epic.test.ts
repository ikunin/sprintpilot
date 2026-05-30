import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import autopilot from '../../_Sprintpilot/bin/autopilot.js';
// @ts-expect-error — CommonJS module
import excluded from '../../_Sprintpilot/lib/orchestrator/excluded-stories.js';

let root: string;

function writeSprintStatus(yaml: string) {
  const dir = join(root, '_bmad-output', 'implementation-artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sprint-status.yaml'), yaml, 'utf8');
}

// Mirrors the Jarvis-style hazard: orphan non-done stories in earlier epics
// sit ABOVE the active epic in document order. Without the preferEpic option
// the resolver would silently pick 6-1 (or null after some additional filters)
// instead of an Epic 18 story.
const ORPHANS_BEFORE_EPIC_18 = `
development_status:
  epic-6: in-progress
  6-1-stale-story: backlog
  6-2-also-stale: backlog
  epic-17: in-progress
  17-4-deferred-but-not-marked: backlog
  epic-18: in-progress
  18-1-first-done: done
  18-2-async-delegate-tool: backlog
  18-3-proactive-push: backlog
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-prefer-epic-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveNextStoryKey(opts.preferEpic) — epic-scoped pick wins over orphan earlier-epic stories', () => {
  it('without preferEpic, returns the first non-terminal entry in document order (the bug)', () => {
    writeSprintStatus(ORPHANS_BEFORE_EPIC_18);
    expect(autopilot.resolveNextStoryKey(root)).toBe('6-1-stale-story');
  });

  it('with preferEpic="18", picks the first remaining story in Epic 18 instead', () => {
    writeSprintStatus(ORPHANS_BEFORE_EPIC_18);
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: '18' })).toBe(
      '18-2-async-delegate-tool',
    );
  });

  it('accepts either "18" or "epic-18" as the preferEpic value', () => {
    writeSprintStatus(ORPHANS_BEFORE_EPIC_18);
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: 'epic-18' })).toBe(
      '18-2-async-delegate-tool',
    );
  });

  it('falls through to the global scan when the preferred epic is exhausted', () => {
    writeSprintStatus(`
development_status:
  epic-6: in-progress
  6-1-stale-story: backlog
  epic-18: in-progress
  18-1-only-story: done
`);
    // Epic 18 has no non-terminal stories left → fall through to global → 6-1.
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: '18' })).toBe('6-1-stale-story');
  });

  it('returns null when the preferred epic is exhausted AND there are no global stories', () => {
    writeSprintStatus(`
development_status:
  epic-18: in-progress
  18-1-done: done
  18-2-also-done: done
`);
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: '18' })).toBeNull();
  });

  it('skips an excluded in-epic story and picks the next in-epic story (composes with v2.6.5 ledger)', () => {
    writeSprintStatus(ORPHANS_BEFORE_EPIC_18);
    excluded.recordExcluded(root, '18-2-async-delegate-tool', { reason: 'user_skip_story' });
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: '18' })).toBe('18-3-proactive-push');
  });

  it('ignored preferEpic options (empty string, undefined, non-string) take the global path', () => {
    writeSprintStatus(ORPHANS_BEFORE_EPIC_18);
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: '' })).toBe('6-1-stale-story');
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: undefined })).toBe('6-1-stale-story');
    expect(autopilot.resolveNextStoryKey(root, {})).toBe('6-1-stale-story');
  });
});
