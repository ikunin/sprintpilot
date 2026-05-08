import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import postGreenMod from '../../_Sprintpilot/scripts/post-green-gates.js';

const { readConfigEnabled } = postGreenMod as {
  readConfigEnabled: (projectRoot: string, sectionName: string) => boolean;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-postgreen-'));
  mkdirSync(path.join(dir, '_Sprintpilot', 'modules', 'autopilot'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readConfigEnabled', () => {
  it('returns true when config is missing (default-on)', () => {
    expect(readConfigEnabled(dir, 'test_pitfalls')).toBe(true);
  });

  it('returns true when section is present and enabled: true', () => {
    writeFileSync(
      path.join(dir, '_Sprintpilot/modules/autopilot/config.yaml'),
      'autopilot:\n  test_pitfalls:\n    enabled: true\n',
    );
    expect(readConfigEnabled(dir, 'test_pitfalls')).toBe(true);
  });

  it('returns false when section is present and enabled: false', () => {
    writeFileSync(
      path.join(dir, '_Sprintpilot/modules/autopilot/config.yaml'),
      'autopilot:\n  test_pitfalls:\n    enabled: false\n',
    );
    expect(readConfigEnabled(dir, 'test_pitfalls')).toBe(false);
  });

  it('does not leak sibling section enabled into another section', () => {
    // Same defense as the chunk-4 review-2 fix: track the block's indent
    // and stop on a same-indent sibling so its `enabled:` doesn't apply.
    writeFileSync(
      path.join(dir, '_Sprintpilot/modules/autopilot/config.yaml'),
      [
        'autopilot:',
        '  ci_parity:',
        '    enabled: true',
        '  test_pitfalls:',
        '    enabled: false',
        '',
      ].join('\n'),
    );
    expect(readConfigEnabled(dir, 'ci_parity')).toBe(true);
    expect(readConfigEnabled(dir, 'test_pitfalls')).toBe(false);
  });
});
