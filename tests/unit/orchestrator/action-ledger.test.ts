import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import ledger from '../../../_Sprintpilot/lib/orchestrator/action-ledger.js';

const { append, read, last, resolveLedgerPath, VALID_KINDS } = ledger as {
  append: (
    entry: Record<string, unknown>,
    context: { projectRoot: string; now?: () => Date },
  ) => Record<string, unknown>;
  read: (
    context: { projectRoot: string },
    options?: { limit?: number },
  ) => Record<string, unknown>[];
  last: (context: { projectRoot: string }, kind?: string) => Record<string, unknown> | null;
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
