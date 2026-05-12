import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import decisionLog from '../../../_Sprintpilot/lib/orchestrator/decision-log.js';

const { validateOne, validateMany, append, nextSeq, VALID_CATEGORIES, VALID_IMPACTS } =
  decisionLog as {
    validateOne: (d: unknown) => { ok: true; decision: unknown } | { ok: false; errors: string[] };
    validateMany: (
      ds: unknown,
    ) =>
      | { ok: true; decisions: unknown[] }
      | { ok: false; errors: { index: number; errors: string[] }[]; valid: unknown[] };
    append: (
      logPath: string,
      decisions: unknown[],
      context: { story: string; now?: () => Date },
    ) => { appended: number; ids: string[] };
    nextSeq: (existing: string) => number;
    VALID_CATEGORIES: string[];
    VALID_IMPACTS: string[];
  };

const validDecision = () => ({
  category: 'test-strategy',
  impact: 'low',
  phase: 'dev-story:RED',
  decision: 'use vitest for new tests',
  rationale: 'matches repo convention',
});

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sp-decision-log-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('validateOne', () => {
  it('accepts a complete valid decision', () => {
    expect(validateOne(validDecision()).ok).toBe(true);
  });

  it('rejects missing fields', () => {
    const bad = { ...validDecision(), category: undefined };
    expect(validateOne(bad).ok).toBe(false);
  });

  it('rejects invalid category', () => {
    const bad = { ...validDecision(), category: 'whim' };
    expect(validateOne(bad).ok).toBe(false);
  });

  it('rejects invalid impact', () => {
    const bad = { ...validDecision(), impact: 'critical' };
    expect(validateOne(bad).ok).toBe(false);
  });

  it('rejects malformed phase', () => {
    const bad = { ...validDecision(), phase: 'dev-story' };
    expect(validateOne(bad).ok).toBe(false);
  });

  it('rejects empty decision / rationale', () => {
    expect(validateOne({ ...validDecision(), decision: '' }).ok).toBe(false);
    expect(validateOne({ ...validDecision(), rationale: '   ' }).ok).toBe(false);
  });

  it('exposes the documented enums', () => {
    expect(VALID_CATEGORIES).toEqual([
      'architecture',
      'test-strategy',
      'dependency',
      'review-triage',
      'review-accept',
      'halt-recovery',
      'scope',
      'workaround',
    ]);
    expect(VALID_IMPACTS).toEqual(['low', 'medium', 'high']);
  });
});

describe('validateMany', () => {
  it('returns ok with all valid', () => {
    const r = validateMany([validDecision(), validDecision()]);
    expect(r.ok).toBe(true);
  });

  it('reports indexed errors', () => {
    const r = validateMany([validDecision(), { ...validDecision(), category: 'bogus' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].index).toBe(1);
    }
  });

  it('returns empty for non-array input', () => {
    const r = validateMany(undefined as unknown);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decisions).toEqual([]);
  });
});

describe('nextSeq', () => {
  it('returns 1 for empty/missing', () => {
    expect(nextSeq('')).toBe(1);
    expect(nextSeq(undefined as unknown as string)).toBe(1);
  });

  it('returns max+1 from existing ids', () => {
    const existing = `
decisions:
  - id: DEC-001
    foo: bar
  - id: DEC-007
    foo: baz
`;
    expect(nextSeq(existing)).toBe(8);
  });
});

describe('append', () => {
  it('creates a fresh log file with header + decisions', () => {
    const logPath = join(tmp, 'decision-log.yaml');
    const result = append(logPath, [validDecision()], {
      story: 'S1.2',
      now: () => new Date('2026-05-12T10:00:00Z'),
    });
    expect(result.appended).toBe(1);
    expect(result.ids).toEqual(['DEC-001']);

    const text = readFileSync(logPath, 'utf8');
    expect(text).toContain('generated: 2026-05-12');
    expect(text).toContain('last_updated: 2026-05-12T10:00:00.000Z');
    expect(text).toContain('decisions:');
    expect(text).toContain('- id: DEC-001');
    expect(text).toContain('story: S1.2');
    expect(text).toContain('phase: dev-story:RED');
    expect(text).toContain('category: test-strategy');
    expect(text).toContain('impact: low');
  });

  it('appends to an existing log, increments seq, updates last_updated', () => {
    const logPath = join(tmp, 'decision-log.yaml');
    append(logPath, [validDecision()], {
      story: 'S1',
      now: () => new Date('2026-05-12T09:00:00Z'),
    });
    const r2 = append(logPath, [validDecision(), validDecision()], {
      story: 'S2',
      now: () => new Date('2026-05-12T10:00:00Z'),
    });
    expect(r2.ids).toEqual(['DEC-002', 'DEC-003']);

    const text = readFileSync(logPath, 'utf8');
    expect(text).toContain('last_updated: 2026-05-12T10:00:00.000Z');
    expect(text).toContain('DEC-001');
    expect(text).toContain('DEC-002');
    expect(text).toContain('DEC-003');
    expect(text).toContain('story: S1');
    expect(text).toContain('story: S2');
  });

  it('handles existing log without last_updated by inserting one', () => {
    const logPath = join(tmp, 'decision-log.yaml');
    writeFileSync(
      logPath,
      ['generated: 2026-05-01', 'decisions:', '  - id: DEC-005', '    foo: bar', ''].join('\n'),
      'utf8',
    );
    const r = append(logPath, [validDecision()], {
      story: 'S3',
      now: () => new Date('2026-05-12T10:00:00Z'),
    });
    expect(r.ids).toEqual(['DEC-006']);
    const text = readFileSync(logPath, 'utf8');
    expect(text).toContain('last_updated: 2026-05-12T10:00:00.000Z');
    expect(text).toContain('DEC-005');
    expect(text).toContain('DEC-006');
  });

  it('escapes values that contain colons / hashes by JSON-quoting', () => {
    const logPath = join(tmp, 'decision-log.yaml');
    append(
      logPath,
      [
        {
          ...validDecision(),
          decision: 'switch to: vitest # not jest',
          rationale: 'reason: cleaner output',
        },
      ],
      { story: 'S1', now: () => new Date('2026-05-12T10:00:00Z') },
    );
    const text = readFileSync(logPath, 'utf8');
    expect(text).toContain('"switch to: vitest # not jest"');
    expect(text).toContain('"reason: cleaner output"');
  });
});
