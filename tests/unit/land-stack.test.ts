import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import landStackMod from '../../lib/commands/land-stack';

const { runLandStack, HaltError } = landStackMod as {
  runLandStack: (opts: Record<string, unknown>) => Promise<{
    landed: number;
    total: number;
    dryRun?: boolean;
  }>;
  HaltError: new (message: string) => Error;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-land-stack-'));
  // A clean repo so the working-tree-cleanliness check passes.
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runLandStack — option validation', () => {
  it('throws on invalid --method', async () => {
    await expect(
      runLandStack({
        platform: 'github',
        method: 'destroy',
        baseBranch: 'main',
        // Pre-empty stack so we don't need a real platform listing.
        stackFromFile: createStackFile(dir, []),
      }),
    ).rejects.toThrow(/invalid --method/);
  });

  it('throws on invalid --on-ci-failure', async () => {
    await expect(
      runLandStack({
        platform: 'github',
        onCiFailure: 'panic',
        stackFromFile: createStackFile(dir, []),
      }),
    ).rejects.toThrow(/invalid --on-ci-failure/);
  });

  it('refuses --stack <pr,pr,...> and points at auto-detection', async () => {
    await expect(runLandStack({ platform: 'github', stack: [123, 124] })).rejects.toThrow(
      /--stack <pr,pr,\.\.\.> is reserved for future use/,
    );
  });
});

describe('runLandStack — short-circuits', () => {
  it('returns landed=0,total=0 on git_only platform', async () => {
    const r = await runLandStack({
      platform: 'git_only',
      stackFromFile: createStackFile(dir, []),
      log: () => {},
    });
    expect(r).toEqual({ landed: 0, total: 0 });
  });

  it('returns landed=0,total=0 when stack is empty', async () => {
    const r = await runLandStack({
      platform: 'github',
      baseBranch: 'main',
      stackFromFile: createStackFile(dir, []),
      log: () => {},
    });
    expect(r).toEqual({ landed: 0, total: 0 });
  });

  it('refuses to run on a dirty working tree without --force', async () => {
    writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted');
    execFileSync('git', ['add', 'dirty.txt'], { cwd: dir });
    process.env.BMAD_PROJECT_ROOT = dir;
    try {
      await expect(
        runLandStack({
          platform: 'github',
          baseBranch: 'main',
          stackFromFile: createStackFile(dir, [
            { number: 1, sourceBranch: 'story/1-1', base: 'main', ci: 'success' },
          ]),
          log: () => {},
        }),
      ).rejects.toThrow(/working tree not clean/);
    } finally {
      delete process.env.BMAD_PROJECT_ROOT;
    }
  });
});

describe('runLandStack — dry run', () => {
  it('prints the plan and exits without executing', async () => {
    const lines: string[] = [];
    process.env.BMAD_PROJECT_ROOT = dir;
    try {
      const r = await runLandStack({
        platform: 'github',
        baseBranch: 'main',
        method: 'merge',
        dryRun: true,
        stackFromFile: createStackFile(dir, [
          {
            number: 1,
            sourceBranch: 'story/1-1',
            base: 'main',
            mergeStateStatus: 'CLEAN',
            ci: 'success',
          },
          {
            number: 2,
            sourceBranch: 'story/1-2',
            base: 'story/1-1',
            mergeStateStatus: 'CLEAN',
            ci: 'pending',
          },
        ]),
        log: (s: string) => lines.push(s),
      });
      expect(r).toEqual({ landed: 0, total: 2, dryRun: true });
      const joined = lines.join('\n');
      expect(joined).toMatch(/2 PRs bottom-up/);
      expect(joined).toMatch(/PR #1/);
      expect(joined).toMatch(/PR #2/);
      expect(joined).toMatch(/Dry run complete/);
    } finally {
      delete process.env.BMAD_PROJECT_ROOT;
    }
  });
});

describe('HaltError', () => {
  it('is a distinct error class with exitCode 3', () => {
    const e = new HaltError('test') as Error & { exitCode?: number; name?: string };
    expect(e.message).toBe('test');
    expect(e.name).toBe('HaltError');
    expect(e.exitCode).toBe(3);
  });
});

function createStackFile(dir: string, stack: unknown): string {
  const p = path.join(dir, 'stack.json');
  writeFileSync(p, JSON.stringify(stack));
  return p;
}
