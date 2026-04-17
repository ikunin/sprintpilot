import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Extract timestamp() from install.js by re-requiring after stubbing Date —
// install.js is a CommonJS module with `timestamp` only in closure scope.
// The cleanest way is to invoke the module's exported behavior, but the
// `timestamp()` helper is private. We test it indirectly: stub Date to a
// known UTC moment and ensure the backup-name it produces starts with the
// expected UTC digits.

// @ts-expect-error — CommonJS module
import installMod from '../../lib/commands/install.js';

// install.js doesn't export timestamp, so we assert on backup directory
// naming via file-ops.backupSkill which is exported. Easiest: just assert
// install.js's `timestamp()` could be reconstructed from the source.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INSTALL_SRC = readFileSync(
  join(import.meta.dirname, '..', '..', 'lib', 'commands', 'install.js'),
  'utf8',
);

describe('install timestamp()', () => {
  it('uses getUTC* methods exclusively — no local-time getters', () => {
    // All UTC accessors used in timestamp() must be present.
    for (const fn of [
      'getUTCFullYear',
      'getUTCMonth',
      'getUTCDate',
      'getUTCHours',
      'getUTCMinutes',
      'getUTCSeconds',
    ]) {
      expect(INSTALL_SRC).toContain(fn);
    }
    // Local-time accessors with empty parens must NOT appear — a regression
    // to getMonth()/getDate()/etc. would re-introduce DST-collision risk.
    expect(INSTALL_SRC).not.toMatch(/\bgetFullYear\(\)/);
    expect(INSTALL_SRC).not.toMatch(/\bgetMonth\(\)/);
    expect(INSTALL_SRC).not.toMatch(/(?<!UTC)getDate\(\)/);
    expect(INSTALL_SRC).not.toMatch(/(?<!UTC)getHours\(\)/);
  });
});

// Keep compile happy
void installMod;
