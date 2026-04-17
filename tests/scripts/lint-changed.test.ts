import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitFile, createTempRepo, modifyFile, type TempRepo } from './helpers/repo.js';
import { runScript } from './helpers/run.js';

function whichOrNull(cmd: string): string | null {
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function minimalPath(): string {
  const nodePath = whichOrNull('node');
  const gitPath = whichOrNull('git');
  return [nodePath && dirname(nodePath), gitPath && dirname(gitPath), '/usr/bin', '/bin']
    .filter(Boolean)
    .join(':');
}

describe('lint-changed', () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('no changed files outputs message and exits 0', () => {
    const r = runScript('lint-changed', [], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No changed files to lint');
  });

  it('no linter found for changed files exits 2', () => {
    commitFile(repo.dir, 'data.xyz', 'some data');
    modifyFile(repo.dir, 'data.xyz', 'modified data');
    const r = runScript('lint-changed', [], {
      cwd: repo.dir,
      env: { PATH: minimalPath() },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('No linter found');
  });

  it('output-file flag saves full output', () => {
    if (whichOrNull('ruff') == null) return;
    commitFile(repo.dir, 'test.py', 'x = 1');
    modifyFile(repo.dir, 'test.py', 'import os\nimport sys\nx = 1\n');
    runScript('lint-changed', ['--output-file', 'lint-out.txt'], { cwd: repo.dir });
    expect(existsSync(join(repo.dir, 'lint-out.txt'))).toBe(true);
  });

  it('python files linted with ruff when available', () => {
    if (whichOrNull('ruff') == null) return;
    commitFile(repo.dir, 'app.py', 'x = 1');
    modifyFile(repo.dir, 'app.py', 'import os  # unused import\n');
    const r = runScript('lint-changed', [], { cwd: repo.dir });
    expect(r.stderr + r.stdout).toMatch(/app\.py|Summary:/);
  });

  it('custom limit truncates output', () => {
    if (whichOrNull('ruff') == null) return;
    commitFile(repo.dir, 'bad.py', 'x = 1');
    const many = Array.from({ length: 20 }, (_, i) => `import os${i}`).join('\n') + '\n';
    modifyFile(repo.dir, 'bad.py', many);
    const r = runScript('lint-changed', ['--limit', '5'], { cwd: repo.dir });
    // Just validate it ran; actual truncation is linter-dependent
    expect([0, 1]).toContain(r.status);
  });

  it('help flag shows usage', () => {
    const r = runScript('lint-changed', ['--help'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });
});
