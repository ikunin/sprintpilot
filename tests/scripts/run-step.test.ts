import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', '..', '_Sprintpilot', 'scripts', 'run-step.js');

function runStep(
  stepJson: object,
  opts: { env?: Record<string, string> } = {},
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync('node', [SCRIPT], {
    input: JSON.stringify(stepJson),
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
  });
  return {
    status: typeof r.status === 'number' ? r.status : 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

describe('run-step.js — canonical step executor', () => {
  it('executes args and exits 0 on success', () => {
    const r = runStep({ args: ['true'] });
    expect(r.status).toBe(0);
  });

  it('propagates exit code on failure (no tolerate/optional)', () => {
    const r = runStep({ args: ['false'] });
    expect(r.status).toBe(1);
  });

  it('honors tolerate_exit_codes — non-zero match → exit 0', () => {
    const r = runStep({ args: ['sh', '-c', 'exit 2'], tolerate_exit_codes: [2] });
    expect(r.status).toBe(0);
  });

  it('rejects when exit code is not in tolerate_exit_codes', () => {
    const r = runStep({ args: ['sh', '-c', 'exit 3'], tolerate_exit_codes: [2] });
    expect(r.status).toBe(3);
  });

  it('honors optional=true — non-zero exit → exit 0 with warning', () => {
    const r = runStep({ args: ['false'], optional: true });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('optional');
  });

  it('passes env to the subprocess (step.env wins over process.env)', () => {
    const r = runStep({
      args: ['sh', '-c', 'echo "$RUN_STEP_TEST_VAR"'],
      env: { RUN_STEP_TEST_VAR: 'from-step' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('from-step');
  });

  it('exits 2 on missing args', () => {
    const r = runStep({ description: 'no args' } as object);
    expect(r.status).toBe(2);
  });

  it('exits 2 on malformed JSON', () => {
    const r = spawnSync('node', [SCRIPT], { input: '{not-json', encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
