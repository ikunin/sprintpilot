import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import userCommands from '../../../_Sprintpilot/lib/orchestrator/user-commands.js';

type ValidResult = { ok: true; commands: unknown[] };
type InvalidResult = { ok: false; errors: { index: number; errors: string[] }[] };

const { validate, validateOne, COMMAND_KINDS } = userCommands as {
  validate: (input: unknown) => ValidResult | InvalidResult;
  validateOne: (cmd: unknown) => { ok: true; command: unknown } | { ok: false; errors: string[] };
  COMMAND_KINDS: string[];
};

describe('validateOne', () => {
  it('accepts skip_story with story_key', () => {
    const r = validateOne({ kind: 'skip_story', story_key: 'S1.2' });
    expect(r.ok).toBe(true);
  });

  it('rejects skip_story without story_key', () => {
    const r = validateOne({ kind: 'skip_story' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('story_key');
  });

  it('rejects malformed story_key', () => {
    const r = validateOne({ kind: 'skip_story', story_key: 'has space' });
    expect(r.ok).toBe(false);
  });

  it('accepts abort_sprint with optional reason', () => {
    expect(validateOne({ kind: 'abort_sprint' }).ok).toBe(true);
    expect(validateOne({ kind: 'abort_sprint', reason: 'changed mind' }).ok).toBe(true);
  });

  it('rejects reason with non-string type', () => {
    const r = validateOne({ kind: 'abort_sprint', reason: 42 });
    expect(r.ok).toBe(false);
  });

  it('accepts override_decision with decision_id + new_value', () => {
    const r = validateOne({
      kind: 'override_decision',
      decision_id: 'DEC-007',
      new_value: 'use vitest',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects override_decision missing new_value', () => {
    const r = validateOne({ kind: 'override_decision', decision_id: 'DEC-007' });
    expect(r.ok).toBe(false);
  });

  it('accepts change_profile with valid profile', () => {
    for (const p of ['nano', 'small', 'medium', 'large', 'legacy']) {
      expect(validateOne({ kind: 'change_profile', profile: p }).ok).toBe(true);
    }
  });

  it('rejects change_profile with unknown profile', () => {
    const r = validateOne({ kind: 'change_profile', profile: 'turbo' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown kind', () => {
    const r = validateOne({ kind: 'launch_nukes' });
    expect(r.ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateOne(null).ok).toBe(false);
    expect(validateOne('skip_story').ok).toBe(false);
    expect(validateOne(42).ok).toBe(false);
  });

  it('rejects missing kind', () => {
    expect(validateOne({}).ok).toBe(false);
  });

  it('exposes all kinds via COMMAND_KINDS', () => {
    expect(COMMAND_KINDS).toContain('skip_story');
    expect(COMMAND_KINDS).toContain('abort_sprint');
    expect(COMMAND_KINDS).toContain('force_continue');
    expect(COMMAND_KINDS).toContain('override_decision');
    expect(COMMAND_KINDS).toContain('change_profile');
    expect(COMMAND_KINDS).toContain('pause');
    expect(COMMAND_KINDS).toContain('accept_alternative');
  });

  it('accepts accept_alternative with no extra args', () => {
    expect(validateOne({ kind: 'accept_alternative' }).ok).toBe(true);
  });

  it('accepts accept_alternative with optional reason', () => {
    expect(validateOne({ kind: 'accept_alternative', reason: 'sounds right' }).ok).toBe(true);
  });

  it('rejects accept_alternative with non-string reason', () => {
    expect(validateOne({ kind: 'accept_alternative', reason: 42 }).ok).toBe(false);
  });
});

describe('validate (batch)', () => {
  it('accepts a single command (wrapped)', () => {
    const r = validate({ kind: 'force_continue' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commands).toHaveLength(1);
  });

  it('accepts an array of valid commands', () => {
    const r = validate([
      { kind: 'skip_story', story_key: 'S1' },
      { kind: 'change_profile', profile: 'small' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commands).toHaveLength(2);
  });

  it('reports all errors with indices', () => {
    const r = validate([
      { kind: 'skip_story', story_key: 'S1' },
      { kind: 'bogus' },
      { kind: 'change_profile' }, // missing profile
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(2);
      expect(r.errors[0].index).toBe(1);
      expect(r.errors[1].index).toBe(2);
    }
  });

  it('handles empty array as valid', () => {
    const r = validate([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commands).toHaveLength(0);
  });
});
