import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScript } from './helpers/run.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-postgreen-e2e-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('post-green-gates (end-to-end)', () => {
  it('emits clean payload when no test files / no signals', () => {
    // Empty project — both gates short-circuit. JSON output should still
    // be valid so the workflow can parse it.
    const r = runScript('post-green-gates', [], { cwd: dir });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload).toHaveProperty('test_pitfalls');
    expect(payload).toHaveProperty('ci_parity_uncertain');
    expect(payload).toHaveProperty('ci_parity_warning');
  });

  it('skips gates when both are disabled in config', () => {
    mkdirSync(path.join(dir, '_Sprintpilot/modules/autopilot'), { recursive: true });
    writeFileSync(
      path.join(dir, '_Sprintpilot/modules/autopilot/config.yaml'),
      [
        'autopilot:',
        '  test_pitfalls:',
        '    enabled: false',
        '  ci_parity:',
        '    enabled: false',
        '',
      ].join('\n'),
    );
    const r = runScript('post-green-gates', [], { cwd: dir });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.test_pitfalls).toBe('skipped');
    expect(payload.ci_parity_uncertain).toBe('');
  });

  it('flags env-dependent skips when ci_parity finds them', () => {
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
    writeFileSync(
      path.join(dir, 'tests/test_db.py'),
      "@pytest.mark.skipif(not has_postgres(), reason='postgres not running')\ndef test_q():\n    pass\n",
    );
    const r = runScript('post-green-gates', [], { cwd: dir });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.ci_parity_uncertain).toBe('true');
    expect(payload.ci_parity_warning).toContain('WARN');
    expect(payload.ci_parity_warning).toContain('postgres');
  });
});
