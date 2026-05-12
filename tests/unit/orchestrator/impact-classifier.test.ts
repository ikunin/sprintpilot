import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import classifier from '../../../_Sprintpilot/lib/orchestrator/impact-classifier.js';

const { classifyImpact, diffArgs } = classifier as {
  classifyImpact: (
    planned: unknown,
    alternative: unknown,
    urgency?: 'low' | 'medium' | 'high',
  ) => 'low' | 'medium' | 'high';
  diffArgs: (a: unknown, b: unknown) => string[];
};

describe('classifyImpact', () => {
  it('classifies different action types as high', () => {
    const planned = { type: 'invoke_skill', skill: 'bmad-dev-story', args: { story_key: 'S1' } };
    const alt = { type: 'run_script', command: ['node', 'foo.js'] };
    expect(classifyImpact(planned, alt)).toBe('high');
  });

  it('classifies different skills (same type) as medium', () => {
    const planned = { type: 'invoke_skill', skill: 'bmad-dev-story', args: { story_key: 'S1' } };
    const alt = { type: 'invoke_skill', skill: 'bmad-quick-dev', args: { story_key: 'S1' } };
    expect(classifyImpact(planned, alt)).toBe('medium');
  });

  it('classifies identical actions as low', () => {
    const planned = { type: 'invoke_skill', skill: 'x', args: { a: 1 } };
    const alt = { type: 'invoke_skill', skill: 'x', args: { a: 1 } };
    expect(classifyImpact(planned, alt)).toBe('low');
  });

  it('classifies whitelist-only arg diff as low', () => {
    const planned = { type: 'invoke_skill', skill: 'x', args: { story_key: 'S1', retry_budget: 2 } };
    const alt = { type: 'invoke_skill', skill: 'x', args: { story_key: 'S1', retry_budget: 3 } };
    expect(classifyImpact(planned, alt)).toBe('low');
  });

  it('classifies non-whitelist arg diff as medium (default safe)', () => {
    const planned = { type: 'invoke_skill', skill: 'x', args: { test_framework: 'jest' } };
    const alt = { type: 'invoke_skill', skill: 'x', args: { test_framework: 'vitest' } };
    expect(classifyImpact(planned, alt)).toBe('medium');
  });

  it('mixed whitelist + non-whitelist diff classifies as medium', () => {
    const planned = { type: 'invoke_skill', skill: 'x', args: { retry_budget: 2, phase: 'red' } };
    const alt = { type: 'invoke_skill', skill: 'x', args: { retry_budget: 3, phase: 'green' } };
    expect(classifyImpact(planned, alt)).toBe('medium');
  });

  it('honors urgency_hint upward (low → high)', () => {
    const planned = { type: 'invoke_skill', skill: 'x', args: { retry_budget: 2 } };
    const alt = { type: 'invoke_skill', skill: 'x', args: { retry_budget: 3 } };
    expect(classifyImpact(planned, alt, 'high')).toBe('high');
  });

  it('honors urgency_hint upward (medium → high)', () => {
    const planned = { type: 'invoke_skill', skill: 'x', args: { phase: 'red' } };
    const alt = { type: 'invoke_skill', skill: 'x', args: { phase: 'green' } };
    expect(classifyImpact(planned, alt, 'high')).toBe('high');
  });

  it('does NOT lower classification — high stays high even with urgency=low', () => {
    const planned = { type: 'invoke_skill', skill: 'x' };
    const alt = { type: 'run_script', command: ['node'] };
    expect(classifyImpact(planned, alt, 'low')).toBe('high');
  });

  it('ignores unknown urgency values', () => {
    const planned = { type: 'invoke_skill', skill: 'x', args: { retry_budget: 1 } };
    const alt = { type: 'invoke_skill', skill: 'x', args: { retry_budget: 2 } };
    // Cast to bypass the type guard for this adversarial case.
    expect(classifyImpact(planned, alt, 'bogus' as unknown as 'low')).toBe('low');
  });

  it('handles run_script command[0] divergence', () => {
    const planned = { type: 'run_script', command: ['node', 'a.js'], args: {} };
    const alt = { type: 'run_script', command: ['node', 'b.js'], args: {} };
    // command[0] is same → falls through to args comparison; args identical → low.
    expect(classifyImpact(planned, alt)).toBe('low');
  });

  it('handles run_script different command[0] as medium', () => {
    const planned = { type: 'run_script', command: ['node', 'a.js'] };
    const alt = { type: 'run_script', command: ['python', 'a.py'] };
    expect(classifyImpact(planned, alt)).toBe('medium');
  });

  it('handles git_op divergent op as medium', () => {
    const planned = { type: 'git_op', op: 'push' };
    const alt = { type: 'git_op', op: 'force-push' };
    expect(classifyImpact(planned, alt)).toBe('medium');
  });

  it('treats non-object inputs as high', () => {
    expect(classifyImpact(null, {})).toBe('high');
    expect(classifyImpact({ type: 'x' }, null)).toBe('high');
  });
});

describe('diffArgs', () => {
  it('returns empty array for deeply-equal args', () => {
    expect(diffArgs({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  it('detects added keys', () => {
    expect(diffArgs({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
  });

  it('detects removed keys', () => {
    expect(diffArgs({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
  });

  it('detects changed values', () => {
    expect(diffArgs({ a: 1 }, { a: 2 })).toEqual(['a']);
  });

  it('treats missing args object as empty', () => {
    expect(diffArgs(undefined, { a: 1 })).toEqual(['a']);
    expect(diffArgs({ a: 1 }, undefined)).toEqual(['a']);
  });
});
