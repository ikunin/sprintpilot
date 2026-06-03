// Phase 5 — validator tests for the 4 new plan-aware command kinds.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import applierMod from '../../../_Sprintpilot/lib/orchestrator/user-command-applier.js';
// @ts-expect-error — CommonJS module
import userCommands from '../../../_Sprintpilot/lib/orchestrator/user-commands.js';

type ValidOk = { ok: true; command: unknown };
type ValidFail = { ok: false; errors: string[] };

const { validateOne, COMMAND_KINDS } = userCommands as {
  validateOne: (cmd: unknown) => ValidOk | ValidFail;
  COMMAND_KINDS: string[];
};

const { apply, applyOne } = applierMod as {
  applyOne: (
    state: Record<string, unknown>,
    profile: Record<string, unknown>,
    cmd: Record<string, unknown>,
  ) => {
    newState: Record<string, unknown>;
    newProfile: Record<string, unknown>;
    effects: Array<{ kind: string; [k: string]: unknown }>;
  };
  apply: typeof applyOne;
};

// ──────────────────────────────────────────────────────────────────
// COMMAND_KINDS lists the new kinds
// ──────────────────────────────────────────────────────────────────

describe('COMMAND_KINDS — v2.3.0 additions', () => {
  it('includes reorder_queue / add_to_sprint / remove_from_sprint / replan_sprint', () => {
    for (const kind of ['reorder_queue', 'add_to_sprint', 'remove_from_sprint', 'replan_sprint']) {
      expect(COMMAND_KINDS).toContain(kind);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// reorder_queue validation
// ──────────────────────────────────────────────────────────────────

describe('validateOne reorder_queue', () => {
  it('accepts a valid order array', () => {
    const r = validateOne({ kind: 'reorder_queue', order: ['1-1-a', '1-2-b'] });
    expect(r.ok).toBe(true);
  });

  it('rejects an empty order', () => {
    const r = validateOne({ kind: 'reorder_queue', order: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/non-empty/);
  });

  it('rejects a missing order field', () => {
    const r = validateOne({ kind: 'reorder_queue' });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed entries', () => {
    const r = validateOne({ kind: 'reorder_queue', order: ['ok-key', 'has space'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/has space/);
  });

  it('rejects duplicate entries', () => {
    const r = validateOne({ kind: 'reorder_queue', order: ['a', 'b', 'a'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/duplicate/);
  });
});

// ──────────────────────────────────────────────────────────────────
// add_to_sprint validation
// ──────────────────────────────────────────────────────────────────

describe('validateOne add_to_sprint', () => {
  it('accepts a basic call with story_keys only', () => {
    const r = validateOne({ kind: 'add_to_sprint', story_keys: ['1-3-add-auth'] });
    expect(r.ok).toBe(true);
  });

  it("accepts position='end'", () => {
    const r = validateOne({
      kind: 'add_to_sprint',
      story_keys: ['x'],
      position: 'end',
    });
    expect(r.ok).toBe(true);
  });

  it("accepts position='after:<key>'", () => {
    const r = validateOne({
      kind: 'add_to_sprint',
      story_keys: ['x'],
      position: 'after:1-1-a',
    });
    expect(r.ok).toBe(true);
  });

  it('accepts integer position', () => {
    const r = validateOne({
      kind: 'add_to_sprint',
      story_keys: ['x'],
      position: 2,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown position string', () => {
    const r = validateOne({
      kind: 'add_to_sprint',
      story_keys: ['x'],
      position: 'somewhere',
    });
    expect(r.ok).toBe(false);
  });

  it('accepts a valid issue_ids map', () => {
    const r = validateOne({
      kind: 'add_to_sprint',
      story_keys: ['x'],
      issue_ids: { x: 'PROJ-1', y: null },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects issue_ids with bad keys', () => {
    const r = validateOne({
      kind: 'add_to_sprint',
      story_keys: ['x'],
      issue_ids: { 'has space': 'PROJ-1' },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects empty story_keys', () => {
    const r = validateOne({ kind: 'add_to_sprint', story_keys: [] });
    expect(r.ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// remove_from_sprint validation
// ──────────────────────────────────────────────────────────────────

describe('validateOne remove_from_sprint', () => {
  it('accepts a valid call with default status', () => {
    const r = validateOne({ kind: 'remove_from_sprint', story_keys: ['a', 'b'] });
    expect(r.ok).toBe(true);
  });

  it("accepts mark_status='skipped'", () => {
    expect(
      validateOne({ kind: 'remove_from_sprint', story_keys: ['a'], mark_status: 'skipped' }).ok,
    ).toBe(true);
  });

  it("accepts mark_status='deferred'", () => {
    expect(
      validateOne({ kind: 'remove_from_sprint', story_keys: ['a'], mark_status: 'deferred' }).ok,
    ).toBe(true);
  });

  it('rejects unknown mark_status', () => {
    const r = validateOne({
      kind: 'remove_from_sprint',
      story_keys: ['a'],
      mark_status: 'cancelled',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects empty story_keys', () => {
    const r = validateOne({ kind: 'remove_from_sprint', story_keys: [] });
    expect(r.ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// replan_sprint validation
// ──────────────────────────────────────────────────────────────────

describe('validateOne replan_sprint', () => {
  it('accepts the kind with no payload', () => {
    expect(validateOne({ kind: 'replan_sprint' }).ok).toBe(true);
  });

  it('accepts an optional reason string', () => {
    expect(validateOne({ kind: 'replan_sprint', reason: 'priorities shifted' }).ok).toBe(true);
  });

  it('rejects a non-string reason', () => {
    expect(validateOne({ kind: 'replan_sprint', reason: 42 }).ok).toBe(false);
  });

  it('accepts focus_epics + scheduling', () => {
    expect(
      validateOne({
        kind: 'replan_sprint',
        focus_epics: ['21'],
        scheduling: 'top',
      }).ok,
    ).toBe(true);
  });

  it('accepts focus_stories', () => {
    expect(
      validateOne({
        kind: 'replan_sprint',
        focus_stories: ['21-3-add-auth', '21-4-router'],
      }).ok,
    ).toBe(true);
  });

  it('rejects focus_epics with an empty array', () => {
    expect(validateOne({ kind: 'replan_sprint', focus_epics: [] }).ok).toBe(false);
  });

  it('rejects focus_epics with a non-array value', () => {
    expect(validateOne({ kind: 'replan_sprint', focus_epics: '21' }).ok).toBe(false);
  });

  it('rejects focus_epics entries that fail the regex', () => {
    expect(validateOne({ kind: 'replan_sprint', focus_epics: ['valid', 'has space'] }).ok).toBe(
      false,
    );
  });

  it('rejects an unknown scheduling mode', () => {
    expect(validateOne({ kind: 'replan_sprint', scheduling: 'whatever' }).ok).toBe(false);
  });

  it('accepts every valid scheduling mode', () => {
    for (const mode of ['top', 'focus_only', 'append', 'custom']) {
      expect(validateOne({ kind: 'replan_sprint', scheduling: mode }).ok).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Applier behavior
// ──────────────────────────────────────────────────────────────────

describe('applyOne — plan-aware kinds', () => {
  const baseState = { phase: 'dev_green', story_key: '1-1-a' };
  const baseProfile = { implementation_flow: 'full' };

  it('reorder_queue emits a plan_reorder side-effect', () => {
    const r = applyOne(baseState, baseProfile, {
      kind: 'reorder_queue',
      order: ['1-1-a', '1-2-b'],
    });
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0].kind).toBe('plan_reorder');
    expect(r.effects[0].order).toEqual(['1-1-a', '1-2-b']);
    // No state-machine phase change for inline edits.
    expect(r.newState).toEqual(baseState);
  });

  it('add_to_sprint emits a plan_add_stories side-effect with defaults', () => {
    const r = applyOne(baseState, baseProfile, {
      kind: 'add_to_sprint',
      story_keys: ['1-3-add-auth'],
    });
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0].kind).toBe('plan_add_stories');
    expect(r.effects[0].position).toBe('end');
    expect(r.effects[0].issue_ids).toBeNull();
  });

  it('add_to_sprint passes position + issue_ids through', () => {
    const r = applyOne(baseState, baseProfile, {
      kind: 'add_to_sprint',
      story_keys: ['x'],
      position: 'after:y',
      issue_ids: { x: 'PROJ-1' },
    });
    expect(r.effects[0].position).toBe('after:y');
    expect(r.effects[0].issue_ids).toEqual({ x: 'PROJ-1' });
  });

  it('remove_from_sprint emits plan_remove_stories with default status', () => {
    const r = applyOne(baseState, baseProfile, {
      kind: 'remove_from_sprint',
      story_keys: ['a'],
    });
    expect(r.effects[0].kind).toBe('plan_remove_stories');
    expect(r.effects[0].mark_status).toBe('skipped');
  });

  it("remove_from_sprint honors mark_status='deferred'", () => {
    const r = applyOne(baseState, baseProfile, {
      kind: 'remove_from_sprint',
      story_keys: ['a'],
      mark_status: 'deferred',
    });
    expect(r.effects[0].mark_status).toBe('deferred');
  });

  it('replan_sprint sets replan_requested + halt_requested and emits halt', () => {
    const r = applyOne(baseState, baseProfile, {
      kind: 'replan_sprint',
      reason: 'priorities shifted',
    });
    expect(r.newState.replan_requested).toMatchObject({ reason: 'priorities shifted' });
    expect(r.newState.halt_requested).toBeDefined();
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0].kind).toBe('halt');
    expect(r.effects[0].reason).toBe('user_replan_sprint');
  });

  it('replan_sprint carries focus_epics / focus_stories / scheduling into replan_requested', () => {
    const r = applyOne(baseState, baseProfile, {
      kind: 'replan_sprint',
      reason: 'focus on next epic',
      focus_epics: ['21'],
      focus_stories: ['21-3-add-auth'],
      scheduling: 'top',
    });
    expect(r.newState.replan_requested).toMatchObject({
      reason: 'focus on next epic',
      focus_epics: ['21'],
      focus_stories: ['21-3-add-auth'],
      scheduling: 'top',
    });
  });

  it('replan_sprint nulls out absent focus / scheduling fields', () => {
    const r = applyOne(baseState, baseProfile, { kind: 'replan_sprint' });
    expect(r.newState.replan_requested).toMatchObject({
      focus_epics: null,
      focus_stories: null,
      scheduling: null,
    });
  });
});
