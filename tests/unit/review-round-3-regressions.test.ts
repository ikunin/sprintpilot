// Regression tests for the third adversarial-review round.
//
// A   recommendation message wrongly suggested `resolve-docs` for DIRTY
//     PR state (covered by updates to existing stack-snapshot tests)
// B   land-stack treated `git merge` exit-128 as "driver resolved
//     everything" (source-level guard here)
// C   workflow uses `!= AND !=` form instead of `not in (...)` (workflow
//     prose, exercised at runtime)
// D   stack-snapshot e2e now asserts dirty_prs: [...] in YAML body
//     (covered in tests/scripts/stack-snapshot.test.ts)
// E   dirty_prs values flow through escYaml (verified in unit tests via
//     the escYaml + renderStackYaml paths)
// F   pr-watch documents consecutive_unknown / gave_up (header comment
//     change, no code-level test needed)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('regression B — land-stack distinguishes git merge exit codes', () => {
  it('explicitly rejects exit codes other than 1 (conflicts) and 0 (clean)', () => {
    // The previous code treated EVERY non-zero exit as conflicts and
    // would try to `git commit --no-edit` on an exit-128 fatal, failing
    // with a confusing "nothing to commit" downstream instead of the
    // original git stderr. The new code halts immediately on exit ≠ 1.
    const src = readFileSync(
      path.resolve(__dirname, '..', '..', 'lib', 'commands', 'land-stack.js'),
      'utf8',
    );
    expect(src).toMatch(/merge\.exitCode\s*!==?\s*1/);
    // Halt error message names the merge target so users can find what
    // failed without re-running with extra logging.
    expect(src).toMatch(/git merge .*\$\{base\}.* failed/);
  });
});

// Regression A (DIRTY-PR recommendation no longer mentions resolve-docs)
// is covered by direct runtime assertions in tests/unit/stack-snapshot.test.ts
// and tests/scripts/stack-snapshot.test.ts. We don't add a source-level
// guard here because the function's comment legitimately mentions
// `resolve-docs` to explain *why* we don't recommend it — a substring
// search would false-positive against the explanation.

describe('regression E — dirty_prs YAML emission uses escYaml', () => {
  it('source threads dirty_prs values through escYaml in renderStackYaml', () => {
    const src = readFileSync(
      path.resolve(__dirname, '..', '..', '_Sprintpilot', 'scripts', 'stack-snapshot.js'),
      'utf8',
    );
    // Carve out the renderStackYaml function body to scope the assertion.
    const match = src.match(/function renderStackYaml\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(match).not.toBeNull();
    const fn = match?.[0] ?? '';
    // The dirty_prs emission line invokes escYaml on every value.
    expect(fn).toMatch(/dirty_prs:.*\.map\(\(\w+\)\s*=>\s*escYaml\(\w+\)\)/);
  });
});
