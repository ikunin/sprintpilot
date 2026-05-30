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

// Models the orphan-earlier-epics hazard: non-done entries in earlier epics
// sit ABOVE the active epic in document order. Without the preferEpic option
// the resolver picks the first non-terminal entry globally (here `1-1-a`),
// not a story from the active epic.
const ORPHANS_BEFORE_ACTIVE_EPIC = `
development_status:
  epic-1: in-progress
  1-1-a: backlog
  1-2-b: backlog
  epic-2: in-progress
  2-1-c: backlog
  epic-3: in-progress
  3-1-x: done
  3-2-y: backlog
  3-3-z: backlog
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-prefer-epic-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveNextStoryKey(opts.preferEpic) — epic-scoped pick wins over orphan earlier-epic entries', () => {
  it('without preferEpic, returns the first non-terminal entry in document order (the bug)', () => {
    writeSprintStatus(ORPHANS_BEFORE_ACTIVE_EPIC);
    expect(autopilot.resolveNextStoryKey(root)).toBe('1-1-a');
  });

  it('with preferEpic="3", picks the first remaining entry in that epic instead', () => {
    writeSprintStatus(ORPHANS_BEFORE_ACTIVE_EPIC);
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: '3' })).toBe('3-2-y');
  });

  it('accepts either bare number or `epic-N` form as the preferEpic value', () => {
    writeSprintStatus(ORPHANS_BEFORE_ACTIVE_EPIC);
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: 'epic-3' })).toBe('3-2-y');
  });

  it('falls through to the global scan when the preferred epic is exhausted', () => {
    writeSprintStatus(`
development_status:
  epic-1: in-progress
  1-1-a: backlog
  epic-3: in-progress
  3-1-x: done
`);
    // Epic 3 has no non-terminal entries left → fall through to global → 1-1-a.
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: '3' })).toBe('1-1-a');
  });

  it('returns null when the preferred epic is exhausted AND there is nothing globally', () => {
    writeSprintStatus(`
development_status:
  epic-3: in-progress
  3-1-x: done
  3-2-y: done
`);
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: '3' })).toBeNull();
  });

  it('skips an excluded in-epic entry and picks the next (composes with v2.6.5 ledger)', () => {
    writeSprintStatus(ORPHANS_BEFORE_ACTIVE_EPIC);
    excluded.recordExcluded(root, '3-2-y', { reason: 'user_skip_story' });
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: '3' })).toBe('3-3-z');
  });

  it('empty / undefined / missing preferEpic falls through to the global path', () => {
    writeSprintStatus(ORPHANS_BEFORE_ACTIVE_EPIC);
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: '' })).toBe('1-1-a');
    expect(autopilot.resolveNextStoryKey(root, { preferEpic: undefined })).toBe('1-1-a');
    expect(autopilot.resolveNextStoryKey(root, {})).toBe('1-1-a');
  });
});
