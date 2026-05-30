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

// Two non-terminal stories — neither is `done`/`deferred`/etc., so both are
// pickable by the base resolver. This lets us prove the exclusion ledger is
// what removes a story from contention (simulating a BMad re-plan that reset a
// parked story back onto its canonical ladder).
const TWO_READY = `
development_status:
  epic-1: in-progress
  1-7-foo:
    status: ready-for-dev
  1-8-bar:
    status: ready-for-dev
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-excl-resolver-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveNextStoryKey honors the exclusion ledger', () => {
  it('picks the first story when nothing is excluded', () => {
    writeSprintStatus(TWO_READY);
    expect(autopilot.resolveNextStoryKey(root)).toBe('1-7-foo');
  });

  it('skips an excluded story even though sprint-status shows it ready-for-dev', () => {
    writeSprintStatus(TWO_READY);
    excluded.recordExcluded(root, '1-7-foo', { reason: 'user_skip_story' });
    expect(autopilot.resolveNextStoryKey(root)).toBe('1-8-bar');
  });

  it('returns null when every remaining story is excluded', () => {
    writeSprintStatus(TWO_READY);
    excluded.recordExcluded(root, ['1-7-foo', '1-8-bar']);
    expect(autopilot.resolveNextStoryKey(root)).toBeNull();
  });

  it('un-excluding (add_to_sprint) makes the story pickable again', () => {
    writeSprintStatus(TWO_READY);
    excluded.recordExcluded(root, '1-7-foo');
    expect(autopilot.resolveNextStoryKey(root)).toBe('1-8-bar');
    excluded.removeExcluded(root, '1-7-foo');
    expect(autopilot.resolveNextStoryKey(root)).toBe('1-7-foo');
  });
});

describe('resolveNextStoryKey reconciles externally-parked stories', () => {
  it('folds a sprint-status `deferred` into the ledger and survives a later clobber', () => {
    // Sprint-status initially shows 1-7-foo deferred (externally — e.g. a
    // hand-edit, or any path that wrote a non-canonical terminal value).
    writeSprintStatus(`
development_status:
  epic-1: in-progress
  1-7-foo:
    status: deferred
  1-8-bar:
    status: ready-for-dev
`);
    expect(autopilot.resolveNextStoryKey(root)).toBe('1-8-bar');
    // The resolver should have folded 1-7-foo into the owned ledger.
    expect(excluded.isExcluded(root, '1-7-foo')).toBe(true);

    // Now simulate a BMad re-plan clobbering deferred → ready-for-dev. The
    // resolver must still skip 1-7-foo because the ledger remembers.
    writeSprintStatus(TWO_READY);
    expect(autopilot.resolveNextStoryKey(root)).toBe('1-8-bar');
    expect(excluded.isExcluded(root, '1-7-foo')).toBe(true);
  });

  it('does NOT fold `done` into the ledger', () => {
    writeSprintStatus(`
development_status:
  epic-1: in-progress
  1-7-foo:
    status: done
  1-8-bar:
    status: ready-for-dev
`);
    expect(autopilot.resolveNextStoryKey(root)).toBe('1-8-bar');
    expect(excluded.isExcluded(root, '1-7-foo')).toBe(false);
  });
});

describe('persistedStoryRejectionReason honors the exclusion ledger', () => {
  it('keeps a valid, non-excluded current story', () => {
    writeSprintStatus(TWO_READY);
    expect(autopilot.persistedStoryRejectionReason('1-7-foo', root)).toBeNull();
  });

  it('rejects an excluded current story even when sprint-status shows ready-for-dev', () => {
    writeSprintStatus(TWO_READY);
    excluded.recordExcluded(root, '1-7-foo', { reason: 'user_skip_story' });
    const reason = autopilot.persistedStoryRejectionReason('1-7-foo', root);
    expect(reason).toBeTruthy();
    expect(String(reason)).toMatch(/exclusion ledger/i);
  });
});
