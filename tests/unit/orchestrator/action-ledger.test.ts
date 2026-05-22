import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import ledger from '../../../_Sprintpilot/lib/orchestrator/action-ledger.js';

const { append, read, last, lastWithFingerprint, resolveLedgerPath, VALID_KINDS } = ledger as {
  append: (
    entry: Record<string, unknown>,
    context: { projectRoot: string; now?: () => Date },
  ) => Record<string, unknown>;
  read: (
    context: { projectRoot: string },
    options?: { limit?: number },
  ) => Record<string, unknown>[];
  last: (context: { projectRoot: string }, kind?: string) => Record<string, unknown> | null;
  lastWithFingerprint: (context: { projectRoot: string }) => Record<string, unknown> | null;
  resolveLedgerPath: (projectRoot: string) => string;
  VALID_KINDS: string[];
};

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sp-ledger-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('append', () => {
  it('persists a stamped entry with seq + ts', () => {
    const r = append(
      { kind: 'action_emitted', phase: 'create_story', action: { type: 'invoke_skill' } },
      { projectRoot, now: () => new Date('2026-05-12T10:00:00Z') },
    );
    expect(r.seq).toBe(1);
    expect(r.ts).toBe('2026-05-12T10:00:00.000Z');
    expect(r.kind).toBe('action_emitted');
  });

  it('increments seq across appends', () => {
    append({ kind: 'action_emitted' }, { projectRoot });
    const r2 = append({ kind: 'signal_recorded' }, { projectRoot });
    expect(r2.seq).toBe(2);
    const r3 = append({ kind: 'verify_result' }, { projectRoot });
    expect(r3.seq).toBe(3);
  });

  it('rejects unknown kind', () => {
    expect(() => append({ kind: 'bogus' }, { projectRoot })).toThrow();
  });

  it('rejects non-object entry', () => {
    expect(() => append(null as unknown as Record<string, unknown>, { projectRoot })).toThrow();
  });

  it('requires projectRoot', () => {
    expect(() => append({ kind: 'halt' }, {} as { projectRoot: string })).toThrow();
  });

  it('exposes all documented kinds', () => {
    for (const k of [
      'action_emitted',
      'signal_recorded',
      'verify_result',
      'state_transition',
      'profile_escalated',
      'decisions_appended',
      'verify_override',
      'verify_rejected',
      'halt',
    ]) {
      expect(VALID_KINDS).toContain(k);
    }
  });
});

describe('read', () => {
  it('returns empty list when ledger file is missing', () => {
    expect(read({ projectRoot })).toEqual([]);
  });

  it('reads back all appended entries in order', () => {
    append({ kind: 'action_emitted', phase: 'dev_red' }, { projectRoot });
    append({ kind: 'signal_recorded', status: 'success' }, { projectRoot });
    const entries = read({ projectRoot });
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('action_emitted');
    expect(entries[1].kind).toBe('signal_recorded');
  });

  it('skips corrupt tail lines gracefully', () => {
    append({ kind: 'action_emitted' }, { projectRoot });
    const filePath = resolveLedgerPath(projectRoot);
    const valid = readFileSync(filePath, 'utf8');
    writeFileSync(filePath, `${valid}{not-json\n`, 'utf8');
    const entries = read({ projectRoot });
    expect(entries).toHaveLength(1);
  });

  it('limit returns the last N entries', () => {
    for (let i = 0; i < 5; i += 1) {
      append({ kind: 'action_emitted', i }, { projectRoot });
    }
    const tail = read({ projectRoot }, { limit: 2 });
    expect(tail).toHaveLength(2);
    expect(tail[0].i).toBe(3);
    expect(tail[1].i).toBe(4);
  });
});

describe('last', () => {
  it('returns the most recent entry overall when no kind filter', () => {
    append({ kind: 'action_emitted' }, { projectRoot });
    append({ kind: 'signal_recorded' }, { projectRoot });
    expect(last({ projectRoot })?.kind).toBe('signal_recorded');
  });

  it('filters by kind when provided', () => {
    append({ kind: 'action_emitted', phase: 'a' }, { projectRoot });
    append({ kind: 'signal_recorded' }, { projectRoot });
    append({ kind: 'action_emitted', phase: 'b' }, { projectRoot });
    const e = last({ projectRoot }, 'action_emitted');
    expect(e?.phase).toBe('b');
  });

  it('returns null when ledger is empty', () => {
    expect(last({ projectRoot })).toBeNull();
  });

  it('returns null when kind not found', () => {
    append({ kind: 'action_emitted' }, { projectRoot });
    expect(last({ projectRoot }, 'halt')).toBeNull();
  });
});

// v2.3.9 — divergence baseline lookup. The resume-divergence detector
// reads the most-recent entry carrying a `.fingerprint` field, which
// can be either a clean `halt` or a `resume` with `divergence_accepted`
// that re-baselined. Pre-fix the lookup was `last('halt')` only, so
// accepted divergences never refreshed the baseline and re-fired on
// every subsequent `autopilot start`.
describe('lastWithFingerprint', () => {
  it('returns null when no entry carries a fingerprint', () => {
    append({ kind: 'action_emitted' }, { projectRoot });
    append({ kind: 'signal_recorded' }, { projectRoot });
    expect(lastWithFingerprint({ projectRoot })).toBeNull();
  });

  it('returns the most recent entry that carries a fingerprint, regardless of kind', () => {
    append({ kind: 'halt', phase: 'p1', fingerprint: { sprintStatusSha: 'a' } }, { projectRoot });
    append({ kind: 'action_emitted', phase: 'p2' }, { projectRoot }); // no fingerprint
    append({ kind: 'resume', fingerprint: { sprintStatusSha: 'b' } }, { projectRoot });
    append({ kind: 'state_transition' }, { projectRoot }); // no fingerprint
    const r = lastWithFingerprint({ projectRoot });
    expect(r?.kind).toBe('resume');
    expect((r as { fingerprint: { sprintStatusSha: string } }).fingerprint.sprintStatusSha).toBe('b');
  });

  it('regression: resume divergence_accepted with fingerprint becomes the new baseline (no infinite re-acceptance loop)', () => {
    // Scenario mirroring jarvis: a stale halt with fingerprint A. The
    // resumer accepts a divergence, appends a resume with fingerprint B.
    // lastWithFingerprint must surface B (the fresh baseline), not A.
    append({ kind: 'halt', phase: 'story_land', fingerprint: { sprintStatusSha: 'OLD' } }, { projectRoot });
    append(
      {
        kind: 'resume',
        divergence: { kind: 'divergence_accepted', reason: 'external_completion' },
        fingerprint: { sprintStatusSha: 'NEW' },
      },
      { projectRoot },
    );
    const baseline = lastWithFingerprint({ projectRoot });
    expect((baseline as { fingerprint: { sprintStatusSha: string } }).fingerprint.sprintStatusSha).toBe('NEW');
  });

  it('returns the halt baseline when no later resume has a fingerprint', () => {
    append({ kind: 'halt', phase: 'p1', fingerprint: { sprintStatusSha: 'A' } }, { projectRoot });
    append({ kind: 'resume', divergence: { kind: 'resume_divergence' } }, { projectRoot }); // no fingerprint (rejected)
    const r = lastWithFingerprint({ projectRoot });
    expect(r?.kind).toBe('halt');
    expect((r as { fingerprint: { sprintStatusSha: string } }).fingerprint.sprintStatusSha).toBe('A');
  });
});

describe('seq recovery from partial writes', () => {
  it('seq continues from last parsable line even when tail is corrupt', () => {
    append({ kind: 'action_emitted' }, { projectRoot });
    append({ kind: 'signal_recorded' }, { projectRoot });
    const filePath = resolveLedgerPath(projectRoot);
    const existing = readFileSync(filePath, 'utf8');
    writeFileSync(filePath, `${existing}{partial\n`, 'utf8');
    const r = append({ kind: 'verify_result' }, { projectRoot });
    expect(r.seq).toBe(3);
  });
});
