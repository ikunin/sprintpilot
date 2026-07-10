// A4 — BMad-owned tree boundary guard.
//
// BMad v6.9 introduced a shared working-memory primitive at
// `_bmad/scripts/memlog.py`. Sprintpilot keeps its own independent memory
// (decision-log.yaml + ledger.jsonl) and must NEVER write under `_bmad/`
// (it only reads BMad config there). This static guard fails if any shipped
// runtime source starts writing under `_bmad/scripts/` or begins depending on
// memlog, which would collide with BMad's namespace.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ADDON_ROOT = join(__dirname, '..', '..', '_Sprintpilot');
const SCAN_DIRS = ['lib', 'scripts', 'bin'];

function collectJs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectJs(full, acc);
    else if (name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

describe('memlog / _bmad tree non-conflict', () => {
  const files = SCAN_DIRS.flatMap((d) => collectJs(join(ADDON_ROOT, d)));

  it('scans a non-trivial number of runtime source files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no shipped runtime source references memlog', () => {
    const hits = files.filter((f) => /memlog/i.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => f.replace(ADDON_ROOT, '_Sprintpilot'))).toEqual([]);
  });

  it('no shipped runtime source constructs a path under _bmad/scripts', () => {
    // Matches `_bmad/scripts` and `'_bmad', 'scripts'` (path.join form).
    const re = /_bmad['"/\s,]+scripts/;
    const hits = files.filter((f) => re.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => f.replace(ADDON_ROOT, '_Sprintpilot'))).toEqual([]);
  });
});
