import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import prMergeMod from '../../_Sprintpilot/scripts/pr-merge.js';

const { VALID_METHODS } = prMergeMod as {
  VALID_METHODS: string[];
};

describe('pr-merge VALID_METHODS', () => {
  it('exposes the three documented merge methods', () => {
    expect(VALID_METHODS).toEqual(['merge', 'squash', 'rebase']);
  });
});
