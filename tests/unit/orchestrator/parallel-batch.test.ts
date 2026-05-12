import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import pb from '../../../_Sprintpilot/lib/orchestrator/parallel-batch.js';

const { planBatch, classifyResults } = pb as {
  planBatch: (
    children: Record<string, unknown>[],
    profile: Record<string, unknown>,
    hostSupportsParallel: boolean,
  ) => Record<string, unknown>;
  classifyResults: (children: Record<string, unknown>[]) => Record<string, unknown>;
};

describe('planBatch', () => {
  it('emits concurrency up to max_parallel_stories when allowed', () => {
    const r = planBatch(
      [
        { type: 'invoke_skill', skill: 'a' },
        { type: 'invoke_skill', skill: 'b' },
        { type: 'invoke_skill', skill: 'c' },
      ],
      { parallel_stories: true, max_parallel_stories: 2 },
      true,
    );
    expect(r.type).toBe('parallel_batch');
    expect(r.concurrency).toBe(2);
    expect((r.children as unknown[]).length).toBe(3);
  });

  it('caps concurrency at children.length when fewer than max', () => {
    const r = planBatch(
      [{ type: 'invoke_skill', skill: 'a' }],
      { parallel_stories: true, max_parallel_stories: 4 },
      true,
    );
    expect(r.concurrency).toBe(1);
  });

  it('degrades when profile.parallel_stories=false', () => {
    const r = planBatch(
      [
        { type: 'invoke_skill', skill: 'a' },
        { type: 'invoke_skill', skill: 'b' },
      ],
      { parallel_stories: false, max_parallel_stories: 2 },
      true,
    );
    expect(r.degraded).toBe(true);
    expect(r.concurrency).toBe(1);
    expect(r.degraded_reason).toBe('profile.parallel_stories=false');
  });

  it('degrades when host does not support parallel', () => {
    const r = planBatch(
      [{ type: 'invoke_skill', skill: 'a' }],
      { parallel_stories: true, max_parallel_stories: 2 },
      false,
    );
    expect(r.degraded).toBe(true);
    expect(r.degraded_reason).toBe('host_supports_parallel=false');
  });

  it('empty children → zero-concurrency no-op', () => {
    const r = planBatch([], { parallel_stories: true, max_parallel_stories: 2 }, true);
    expect(r.concurrency).toBe(0);
    expect((r.children as unknown[]).length).toBe(0);
  });

  it('throws on non-array children', () => {
    expect(() => planBatch(null as unknown as Record<string, unknown>[], {}, true)).toThrow();
  });
});

describe('classifyResults', () => {
  it('all success → success', () => {
    const r = classifyResults([
      { id: 'a', status: 'success' },
      { id: 'b', status: 'success' },
    ]);
    expect(r.status).toBe('success');
    expect(r.count).toBe(2);
  });

  it('any blocked → blocked with user_input_needed=true', () => {
    const r = classifyResults([
      { id: 'a', status: 'success' },
      { id: 'b', status: 'blocked', reason: 'help' },
    ]);
    expect(r.status).toBe('blocked');
    expect(r.user_input_needed).toBe(true);
    expect(r.children_blocked).toEqual(['b']);
  });

  it('all recoverable failures → failure(recoverable=true)', () => {
    const r = classifyResults([
      { id: 'a', status: 'failure', reason: 'flake', recoverable: true },
      { id: 'b', status: 'failure', reason: 'flake2', recoverable: true },
    ]);
    expect(r.status).toBe('failure');
    expect(r.recoverable).toBe(true);
  });

  it('mixed recoverable + non-recoverable → recoverable: false', () => {
    const r = classifyResults([
      { id: 'a', status: 'failure', recoverable: true },
      { id: 'b', status: 'failure', recoverable: false },
    ]);
    expect(r.recoverable).toBe(false);
  });

  it('empty → success count=0', () => {
    expect(classifyResults([])).toEqual({ status: 'success', count: 0 });
  });
});
