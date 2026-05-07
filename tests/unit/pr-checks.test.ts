import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import prChecksMod from '../../_Sprintpilot/scripts/pr-checks.js';

const { classify, summarizeStates } = prChecksMod as {
  classify: (state: string) => string;
  summarizeStates: (states: string[]) => string;
};

describe('classify (PR check state normalization)', () => {
  it('maps success-like states', () => {
    expect(classify('success')).toBe('success');
    expect(classify('passed')).toBe('success');
    expect(classify('SUCCESS')).toBe('success');
    expect(classify('completed')).toBe('success');
    expect(classify('green')).toBe('success');
    expect(classify('neutral')).toBe('success');
    expect(classify('skipped')).toBe('success');
  });

  it('maps failure-like states', () => {
    expect(classify('failure')).toBe('failure');
    expect(classify('failed')).toBe('failure');
    expect(classify('error')).toBe('failure');
    expect(classify('cancelled')).toBe('failure');
    expect(classify('canceled')).toBe('failure');
    expect(classify('timed_out')).toBe('failure');
    expect(classify('red')).toBe('failure');
  });

  it('maps in-flight states', () => {
    expect(classify('pending')).toBe('pending');
    expect(classify('queued')).toBe('pending');
    expect(classify('running')).toBe('pending');
    expect(classify('in_progress')).toBe('pending');
    expect(classify('waiting_for_resource')).toBe('pending');
  });

  it('maps unknown values to unknown', () => {
    expect(classify('mystery')).toBe('unknown');
    expect(classify('')).toBe('unknown');
    expect(classify(null as unknown as string)).toBe('unknown');
  });
});

describe('summarizeStates', () => {
  it('returns failure when any failure', () => {
    expect(summarizeStates(['success', 'failure', 'success'])).toBe('failure');
  });

  it('returns pending when any pending and no failures', () => {
    expect(summarizeStates(['success', 'pending'])).toBe('pending');
  });

  it('returns success when all success', () => {
    expect(summarizeStates(['success', 'success'])).toBe('success');
  });

  it('returns unknown for empty input', () => {
    expect(summarizeStates([])).toBe('unknown');
  });

  it('returns unknown when mix includes unknown but no failure/pending', () => {
    expect(summarizeStates(['success', 'unknown'])).toBe('unknown');
  });
});
