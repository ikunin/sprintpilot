import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-ci-parity-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ci-parity-scan (end-to-end)', () => {
  it('reports an empty summary when no test runners are detected', () => {
    const r = runScript('ci-parity-scan', [], { cwd: dir });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.summary.intentional).toBe(0);
    expect(payload.summary.env_dependent).toBe(0);
    expect(payload.summary.would_run_in_ci).toBe(false);
    // Every adapter should be present with detected=false.
    expect(payload.runners).toHaveLength(6);
    for (const r of payload.runners) {
      expect(r.detected).toBe(false);
      expect(r.skips).toEqual([]);
    }
  });

  it('classifies a postgres-skipped pytest test as env_dependent', () => {
    writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    writeFileSync(
      path.join(dir, 'tests', 'test_db.py'),
      [
        'import pytest',
        '',
        '@pytest.mark.skipif(not has_postgres(), reason="postgres not running")',
        'def test_query():',
        '    pass',
      ].join('\n'),
    );
    const r = runScript('ci-parity-scan', [], { cwd: dir });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.summary.would_run_in_ci).toBe(true);
    expect(payload.summary.env_dependent).toBe(1);
    expect(payload.summary.intentional).toBe(0);
    const pytestRunner = payload.runners.find((r: { name: string }) => r.name === 'pytest');
    expect(pytestRunner.detected).toBe(true);
    expect(pytestRunner.skips[0].classified_as).toBe('env_dependent');
    expect(pytestRunner.skips[0].matched_pattern).toBe('postgres');
  });

  it('classifies a "slow" skip as intentional and would_run_in_ci stays false', () => {
    writeFileSync(path.join(dir, 'pytest.ini'), '');
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    writeFileSync(
      path.join(dir, 'tests', 'test_a.py'),
      "@pytest.mark.skip(reason='slow integration test')\ndef test_a():\n    pass\n",
    );
    const r = runScript('ci-parity-scan', [], { cwd: dir });
    const payload = JSON.parse(r.stdout);
    expect(payload.summary.intentional).toBe(1);
    expect(payload.summary.env_dependent).toBe(0);
    expect(payload.summary.would_run_in_ci).toBe(false);
  });

  it('honors ci_parity.enabled = false in config.yaml', () => {
    writeFileSync(path.join(dir, 'pytest.ini'), '');
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    writeFileSync(
      path.join(dir, 'tests', 'test_b.py'),
      "@pytest.mark.skip(reason='postgres')\ndef test_b():\n    pass\n",
    );
    mkdirSync(path.join(dir, '_Sprintpilot', 'modules', 'autopilot'), { recursive: true });
    writeFileSync(
      path.join(dir, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml'),
      ['autopilot:', '  ci_parity:', '    enabled: false', ''].join('\n'),
    );
    const r = runScript('ci-parity-scan', [], { cwd: dir });
    const payload = JSON.parse(r.stdout);
    expect(payload.summary.skipped).toContain('ci_parity.enabled = false');
    expect(payload.runners).toEqual([]);
  });
});
