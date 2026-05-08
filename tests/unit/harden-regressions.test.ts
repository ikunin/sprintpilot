// Regression tests for the 5 MEDIUM findings from the adversarial review
// of chunks 1–7. Each block targets one finding so a regression is easy
// to attribute.
//
//   #4  ci_parity config reader leaks into sibling sections
//   #7  redactAuth missing Gitea-style `token <secret>`
//   #11 driver entry crashes when %P is empty AND %A is git's temp file
//   #12 git-status story sort: 1-10 must come after 1-2
//   #13 decision-log re-orders entries on every merge → diff churn

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import platformMod from '../../_Sprintpilot/lib/runtime/platform.js';
// @ts-expect-error — CommonJS module
import yamlMergeMod from '../../_Sprintpilot/lib/runtime/yaml-merge.js';
// @ts-expect-error — CommonJS module
import scanMod from '../../_Sprintpilot/scripts/ci-parity-scan.js';

const { mergeGitStatus, mergeDecisionLog } = yamlMergeMod as {
  mergeGitStatus: (a: string, o: string | null, b: string) => string | null;
  mergeDecisionLog: (a: string, o: string | null, b: string) => string | null;
};
const { redactAuth } = platformMod as { redactAuth: (s: string) => string };
const { readConfig } = scanMod as {
  readConfig: (
    root: string,
  ) => { enabled: boolean; intentional: string[] | null; envDependent: string[] | null } | null;
};

// =============================================================================

describe('regression #4 — ci_parity config sibling-section bug', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sp-harden-config-'));
    mkdirSync(path.join(dir, '_Sprintpilot', 'modules', 'autopilot'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not leak sibling section enabled: false into ci_parity', () => {
    // ci_parity:enabled = true, but a sibling section AFTER it has
    // enabled: false. The buggy reader read every `enabled:` line as
    // ci_parity's because the "left the block" check only fired on
    // 0–1-space-indented lines. Now block-indent is captured and a
    // sibling at the same indent terminates correctly.
    writeFileSync(
      path.join(dir, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml'),
      [
        'autopilot:',
        '  ci_parity:',
        '    enabled: true',
        '  test_pitfalls:',
        '    enabled: false',
        '',
      ].join('\n'),
    );
    const cfg = readConfig(dir);
    expect(cfg).not.toBe(null);
    expect(cfg?.enabled).toBe(true);
  });

  it('still reads ci_parity.enabled when followed by sibling sections', () => {
    writeFileSync(
      path.join(dir, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml'),
      [
        'autopilot:',
        '  test_pitfalls:',
        '    enabled: true',
        '  ci_parity:',
        '    enabled: false',
        '  merge_strategy: manual',
        '',
      ].join('\n'),
    );
    const cfg = readConfig(dir);
    expect(cfg?.enabled).toBe(false);
  });

  it('reads patterns under ci_parity but not from siblings', () => {
    writeFileSync(
      path.join(dir, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml'),
      [
        'autopilot:',
        '  ci_parity:',
        '    enabled: true',
        '    patterns:',
        '      intentional: [slow, smoke]',
        '      env_dependent: [postgres, redis]',
        '  test_pitfalls:',
        '    patterns:',
        '      intentional: [bad, leaked]',
        '',
      ].join('\n'),
    );
    const cfg = readConfig(dir);
    expect(cfg?.intentional).toEqual(['slow', 'smoke']);
    expect(cfg?.envDependent).toEqual(['postgres', 'redis']);
  });
});

// =============================================================================

describe('regression #7 — redactAuth covers Gitea-style token scheme', () => {
  it('redacts `token <value>` in auth-context strings', () => {
    expect(redactAuth('Authorization: token gitea-secret-xyz')).toContain('[REDACTED]');
    expect(redactAuth('Authorization: token gitea-secret-xyz')).not.toContain('gitea-secret-xyz');
  });

  it('redacts `Bearer <value>` (existing behavior preserved)', () => {
    expect(redactAuth('Authorization: Bearer abc123')).toContain('[REDACTED]');
    expect(redactAuth('Authorization: Bearer abc123')).not.toContain('abc123');
  });

  it('redacts `Basic <value>` for older endpoints', () => {
    expect(redactAuth('Authorization: Basic dXNlcjpwYXNz')).toContain('[REDACTED]');
  });

  it('does not strip auth-scheme prefix; only the value', () => {
    // The redactor is intentionally aggressive on `bearer|token|basic`
    // because the alternative — leaking a real secret in an error log —
    // is much costlier than over-redacting an occasional prose mention.
    // Verify the scheme word itself survives so the redaction is
    // recognizable to a human reader.
    expect(redactAuth('Bearer abc123')).toContain('Bearer');
    expect(redactAuth('token gitea-secret')).toContain('token');
    expect(redactAuth('Basic dXNlcjpwYXNz')).toContain('Basic');
  });

  it('does not match mid-identifier "token-thing"', () => {
    // \b boundary prevents matching `token-thing` as if it were the auth
    // scheme. The hyphen is a word boundary so we should NOT redact the
    // suffix.
    const out = redactAuth('repo: token-thing');
    expect(out).toBe('repo: token-thing');
  });
});

// =============================================================================

describe('regression #11 — driver entry: clear error when %P missing AND %A is temp', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sp-harden-driver-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits a hint about git version when %P is empty and %A is .merge_file_*', () => {
    const SCRIPT = path.resolve(
      __dirname,
      '..',
      '..',
      '_Sprintpilot',
      'scripts',
      'auto-merge-bmad-docs.js',
    );
    const aPath = path.join(dir, '.merge_file_aBcDeF');
    writeFileSync(aPath, 'doesnt matter\n');
    writeFileSync(`${aPath}.O`, '');
    writeFileSync(`${aPath}.B`, 'other\n');
    let stderr = '';
    try {
      execFileSync('node', [SCRIPT, aPath, `${aPath}.O`, `${aPath}.B`, ''], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as { stderr?: Buffer };
      stderr = err.stderr?.toString() || '';
    }
    expect(stderr).toMatch(/cannot identify file kind/);
    expect(stderr).toMatch(/git temp file/);
    expect(stderr).toMatch(/%P/);
  });
});

// =============================================================================

describe('regression #12 — git-status story sort: 1-10 after 1-2', () => {
  it('orders 1-10 after 1-9, not between 1-1 and 1-2', () => {
    const HEADER = `# Sprintpilot — Git Status\nstories:\n`;
    const A =
      `${HEADER}` +
      `  1-1:\n    branch: story/1-1\n    last_updated: "2026-04-15T10:00:00Z"\n` +
      `  1-2:\n    branch: story/1-2\n    last_updated: "2026-04-15T10:00:00Z"\n`;
    const B = `${HEADER}  1-10:\n    branch: story/1-10\n    last_updated: "2026-04-15T11:00:00Z"\n`;
    const merged = mergeGitStatus(A, '', B) || '';
    const idx1 = merged.indexOf('1-1:');
    const idx2 = merged.indexOf('1-2:');
    const idx10 = merged.indexOf('1-10:');
    expect(idx1).toBeGreaterThan(0);
    expect(idx2).toBeGreaterThan(idx1);
    // The actual fix: 1-10 lands AFTER 1-2 (and indeed after 1-9 if it
    // existed). Lexicographic sort would have put 1-10 between 1-1 and
    // 1-2 because "1-10" < "1-2" as strings.
    expect(idx10).toBeGreaterThan(idx2);
  });
});

// =============================================================================

describe('regression #13 — decision-log preserves A order; B-only entries appended', () => {
  it("does not re-sort A's existing entries", () => {
    // A has entries 1, 3, 2 (note: NOT in ts-ascending order — perhaps the
    // user manually re-ordered them, or BMad hasn't emitted in ts order).
    // The merge must preserve A's order so a "merge" diff doesn't
    // pointlessly reshuffle existing rows.
    const A = `last_updated: "2026-04-15T12:00:00Z"

decisions:
  - id: "1"
    ts: "2026-04-15T10:00:00Z"
    decision: "first"
  - id: "3"
    ts: "2026-04-15T11:00:00Z"
    decision: "third (out of order)"
  - id: "2"
    ts: "2026-04-15T10:30:00Z"
    decision: "second"
`;
    const B = `last_updated: "2026-04-15T13:00:00Z"

decisions:
  - id: "1"
    ts: "2026-04-15T10:00:00Z"
    decision: "first"
  - id: "3"
    ts: "2026-04-15T11:00:00Z"
    decision: "third (out of order)"
  - id: "2"
    ts: "2026-04-15T10:30:00Z"
    decision: "second"
  - id: "4"
    ts: "2026-04-15T12:00:00Z"
    decision: "fourth"
`;
    const merged = mergeDecisionLog(A, '', B) || '';
    const idx1 = merged.indexOf('id: "1"');
    const idx3 = merged.indexOf('id: "3"');
    const idx2 = merged.indexOf('id: "2"');
    const idx4 = merged.indexOf('id: "4"');
    // A's order — 1, 3, 2 — must be preserved.
    expect(idx1).toBeLessThan(idx3);
    expect(idx3).toBeLessThan(idx2);
    // B-only entry (4) appended at the end.
    expect(idx4).toBeGreaterThan(idx2);
  });

  it('appends multiple B-only entries in ts-ascending order', () => {
    const A = `last_updated: "2026-04-15T10:00:00Z"

decisions:
  - id: "1"
    ts: "2026-04-15T09:00:00Z"
`;
    const B = `last_updated: "2026-04-15T13:00:00Z"

decisions:
  - id: "1"
    ts: "2026-04-15T09:00:00Z"
  - id: "3"
    ts: "2026-04-15T12:00:00Z"
  - id: "2"
    ts: "2026-04-15T10:00:00Z"
`;
    const merged = mergeDecisionLog(A, '', B) || '';
    const idx1 = merged.indexOf('id: "1"');
    const idx2 = merged.indexOf('id: "2"');
    const idx3 = merged.indexOf('id: "3"');
    // 1 (from A) comes first, then B-only sorted by ts: 2 (10:00) before 3 (12:00).
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });
});

// helper used by some tests above to keep linters quiet about unused fs imports
void [readFileSync];
