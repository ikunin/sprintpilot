import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import autoMerge from '../../_Sprintpilot/scripts/auto-merge-bmad-docs.js';

const { classifyChanges, SAFE_PATHS } = autoMerge as {
  classifyChanges: (files: string[]) => { safe: boolean; unsafe: string[] };
  SAFE_PATHS: string[];
};

describe('classifyChanges', () => {
  it('all safe paths → safe: true', () => {
    const r = classifyChanges([
      '_bmad-output/stories/S1.md',
      '_bmad-output/decision-log.yaml',
      '_bmad/bmm/config.yaml',
      'docs/sprint/retrospective.md',
    ]);
    expect(r.safe).toBe(true);
    expect(r.unsafe).toEqual([]);
  });

  it('mixed → safe: false with unsafe listed', () => {
    const r = classifyChanges(['_bmad-output/stories/S1.md', 'src/app.ts']);
    expect(r.safe).toBe(false);
    expect(r.unsafe).toEqual(['src/app.ts']);
  });

  it('empty change list → safe: true (no-op merge)', () => {
    expect(classifyChanges([])).toEqual({ safe: true, unsafe: [] });
  });

  it('SAFE_PATHS exposes documented prefixes', () => {
    expect(SAFE_PATHS).toContain('_bmad-output/');
    expect(SAFE_PATHS).toContain('_bmad/');
  });
});
