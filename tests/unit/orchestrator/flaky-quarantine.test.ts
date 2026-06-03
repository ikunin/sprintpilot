import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import flakyQuarantine from '../../../_Sprintpilot/lib/orchestrator/flaky-quarantine.js';

type State = {
  schema: string;
  last_updated: string | null;
  flips: Array<{
    test_id: string;
    flip_count: number;
    first_observed: string | null;
    last_observed: string | null;
    seen_in_stories: string[];
  }>;
  quarantined: Array<{
    test_id: string;
    flip_count_at_quarantine: number;
    quarantined_at: string | null;
    reason: string;
  }>;
};

const {
  emptyState,
  read,
  write,
  filePath,
  recordFlip,
  promoteToQuarantineMaybe,
  isQuarantined,
  listQuarantined,
  listFlips,
  ejectFromQuarantine,
  quarantineManually,
  DEFAULT_FLIP_THRESHOLD,
  parseYaml,
  dumpYaml,
} = flakyQuarantine as {
  emptyState: () => State;
  read: (root: string) => State;
  write: (root: string, state: State) => void;
  filePath: (root: string) => string;
  recordFlip: (state: State, args: { testId: string; storyKey?: string; now?: string }) => State;
  promoteToQuarantineMaybe: (
    state: State,
    args: { testId: string; threshold?: number; now?: string },
  ) => { state: State; quarantined: boolean };
  isQuarantined: (state: State, testId: string) => boolean;
  listQuarantined: (state: State) => string[];
  listFlips: (state: State) => State['flips'];
  ejectFromQuarantine: (state: State, args: { testId: string }) => State;
  quarantineManually: (
    state: State,
    args: { testId: string; now?: string; reason?: string },
  ) => State;
  DEFAULT_FLIP_THRESHOLD: number;
  parseYaml: (text: string) => Record<string, unknown>;
  dumpYaml: (state: State) => string;
};

let tmpRoot = '';
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-flaky-'));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('flaky-quarantine.emptyState', () => {
  it('returns a fresh shape', () => {
    const s = emptyState();
    expect(s.schema).toBe('sprintpilot.flaky-quarantine.v1');
    expect(s.flips).toEqual([]);
    expect(s.quarantined).toEqual([]);
  });
});

describe('flaky-quarantine.read', () => {
  it('returns empty state when the file does not exist', () => {
    const s = read(tmpRoot);
    expect(s.flips).toEqual([]);
    expect(s.quarantined).toEqual([]);
  });

  it('reads back what write() persisted', () => {
    const before = recordFlip(emptyState(), { testId: 'tests/foo.test.ts', storyKey: '1.1-foo' });
    write(tmpRoot, before);
    const after = read(tmpRoot);
    expect(after.flips).toHaveLength(1);
    expect(after.flips[0].test_id).toBe('tests/foo.test.ts');
    expect(after.last_updated).toMatch(/^\d{4}/);
  });

  it('full roundtrip preserves multi-field quarantine entries', () => {
    let s = quarantineManually(emptyState(), {
      testId: 'tests/flaky.test.ts',
      now: '2026-06-01T12:00:00.000Z',
      reason: 'manual',
    });
    s = recordFlip(s, {
      testId: 'tests/sometimes.test.ts',
      storyKey: '1.1-foo',
      now: '2026-06-01T11:00:00.000Z',
    });
    write(tmpRoot, s);
    const after = read(tmpRoot);
    expect(after.quarantined).toHaveLength(1);
    expect(after.quarantined[0]).toMatchObject({
      test_id: 'tests/flaky.test.ts',
      reason: 'manual',
      quarantined_at: '2026-06-01T12:00:00.000Z',
      flip_count_at_quarantine: 0,
    });
    expect(after.flips).toHaveLength(1);
    expect(after.flips[0]).toMatchObject({
      test_id: 'tests/sometimes.test.ts',
      flip_count: 1,
      first_observed: '2026-06-01T11:00:00.000Z',
      last_observed: '2026-06-01T11:00:00.000Z',
      seen_in_stories: ['1.1-foo'],
    });
  });
});

describe('flaky-quarantine.recordFlip', () => {
  it('creates an entry on first flip', () => {
    const s = recordFlip(emptyState(), {
      testId: 'tests/a.test.ts',
      storyKey: '1.1-foo',
      now: '2026-06-01T12:00:00.000Z',
    });
    expect(s.flips).toHaveLength(1);
    expect(s.flips[0]).toMatchObject({
      test_id: 'tests/a.test.ts',
      flip_count: 1,
      first_observed: '2026-06-01T12:00:00.000Z',
      last_observed: '2026-06-01T12:00:00.000Z',
      seen_in_stories: ['1.1-foo'],
    });
  });

  it('increments flip_count and updates last_observed on repeat', () => {
    let s = recordFlip(emptyState(), {
      testId: 'tests/a.test.ts',
      storyKey: '1.1-foo',
      now: '2026-06-01T12:00:00.000Z',
    });
    s = recordFlip(s, {
      testId: 'tests/a.test.ts',
      storyKey: '1.2-bar',
      now: '2026-06-02T12:00:00.000Z',
    });
    expect(s.flips[0].flip_count).toBe(2);
    expect(s.flips[0].last_observed).toBe('2026-06-02T12:00:00.000Z');
    expect(s.flips[0].seen_in_stories).toEqual(['1.1-foo', '1.2-bar']);
  });

  it('deduplicates story keys', () => {
    let s = recordFlip(emptyState(), { testId: 'x', storyKey: '1.1-foo' });
    s = recordFlip(s, { testId: 'x', storyKey: '1.1-foo' });
    expect(s.flips[0].seen_in_stories).toEqual(['1.1-foo']);
  });

  it('ignores empty testId', () => {
    const s = recordFlip(emptyState(), { testId: '' });
    expect(s.flips).toEqual([]);
  });
});

describe('flaky-quarantine.promoteToQuarantineMaybe', () => {
  it('does not promote when below threshold', () => {
    const s = recordFlip(emptyState(), { testId: 'x', storyKey: 's' });
    const r = promoteToQuarantineMaybe(s, { testId: 'x' });
    expect(r.quarantined).toBe(false);
    expect(r.state.quarantined).toEqual([]);
  });

  it('promotes when flip_count reaches the threshold', () => {
    let s = emptyState();
    for (let i = 0; i < DEFAULT_FLIP_THRESHOLD; i += 1) {
      s = recordFlip(s, { testId: 'x', storyKey: `s${i}` });
    }
    const r = promoteToQuarantineMaybe(s, { testId: 'x' });
    expect(r.quarantined).toBe(true);
    expect(r.state.quarantined).toHaveLength(1);
    expect(r.state.quarantined[0].test_id).toBe('x');
    expect(r.state.quarantined[0].flip_count_at_quarantine).toBe(DEFAULT_FLIP_THRESHOLD);
    // Removed from flips after promotion.
    expect(r.state.flips.find((f) => f.test_id === 'x')).toBeUndefined();
  });

  it('no-op when already quarantined', () => {
    let s = quarantineManually(emptyState(), { testId: 'x' });
    s = recordFlip(s, { testId: 'x' });
    const r = promoteToQuarantineMaybe(s, { testId: 'x' });
    expect(r.quarantined).toBe(false);
  });

  it('honors custom threshold', () => {
    const s = recordFlip(emptyState(), { testId: 'x', storyKey: 's' });
    const r = promoteToQuarantineMaybe(s, { testId: 'x', threshold: 1 });
    expect(r.quarantined).toBe(true);
  });
});

describe('flaky-quarantine.eject / list helpers', () => {
  it('lists quarantined IDs', () => {
    const s = quarantineManually(emptyState(), { testId: 'a' });
    expect(listQuarantined(s)).toEqual(['a']);
    expect(isQuarantined(s, 'a')).toBe(true);
    expect(isQuarantined(s, 'b')).toBe(false);
  });

  it('ejects a quarantined ID', () => {
    let s = quarantineManually(emptyState(), { testId: 'a' });
    s = ejectFromQuarantine(s, { testId: 'a' });
    expect(listQuarantined(s)).toEqual([]);
  });

  it('listFlips returns a copy', () => {
    const s = recordFlip(emptyState(), { testId: 'a' });
    const f = listFlips(s);
    expect(f).toHaveLength(1);
    f[0].flip_count = 999;
    expect(s.flips[0].flip_count).toBe(1); // original untouched
  });
});

describe('flaky-quarantine.quarantineManually', () => {
  it('appends a manual quarantine entry', () => {
    const s = quarantineManually(emptyState(), { testId: 'a', reason: 'known broken' });
    expect(s.quarantined[0].reason).toBe('known broken');
  });

  it('no-op when already quarantined', () => {
    let s = quarantineManually(emptyState(), { testId: 'a' });
    s = quarantineManually(s, { testId: 'a' });
    expect(s.quarantined).toHaveLength(1);
  });
});

describe('flaky-quarantine.parseYaml + dumpYaml roundtrip', () => {
  it('round-trips a non-trivial state', () => {
    const original: State = {
      schema: 'sprintpilot.flaky-quarantine.v1',
      last_updated: '2026-06-01T12:00:00.000Z',
      flips: [
        {
          test_id: 'tests/a.test.ts',
          flip_count: 2,
          first_observed: '2026-06-01T11:00:00.000Z',
          last_observed: '2026-06-01T12:00:00.000Z',
          seen_in_stories: ['1.1-foo', '1.2-bar'],
        },
      ],
      quarantined: [
        {
          test_id: 'tests/b.test.ts',
          flip_count_at_quarantine: 3,
          quarantined_at: '2026-06-02T08:00:00.000Z',
          reason: 'exceeded_flip_threshold',
        },
      ],
    };
    const text = dumpYaml(original);
    const parsed = parseYaml(text) as Record<string, unknown>;
    expect(parsed.schema).toBe('sprintpilot.flaky-quarantine.v1');
    expect(Array.isArray(parsed.flips)).toBe(true);
    expect(Array.isArray(parsed.quarantined)).toBe(true);
  });
});

describe('flaky-quarantine.filePath', () => {
  it('returns the canonical location', () => {
    const fp = filePath('/r');
    expect(
      fp.endsWith(path.join('_bmad-output', 'implementation-artifacts', 'flaky-quarantine.yaml')),
    ).toBe(true);
  });
});
