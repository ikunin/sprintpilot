import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS
import { resolveTestScope } from '../../../_Sprintpilot/lib/orchestrator/testing/scope.js';

type Decision = {
  scope: 'affected' | 'full';
  adapter: string | null;
  command: string | null;
  changed_files: string[] | null;
  test_files: string[];
  reason: string;
  fallback: boolean;
};

let projectRoot: string;

function git(args: string[]): void {
  execFileSync('git', ['-C', projectRoot, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function seedVitestProject(): void {
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', devDependencies: { vitest: '^3.0.0' } }),
  );
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sp-test-scope-'));
  // Build a minimal git repo with main + a feature branch with one diff.
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'tester']);
  git(['checkout', '-q', '-b', 'main']);
  writeFileSync(join(projectRoot, 'README.md'), '# fixture\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'init']);
  git(['checkout', '-q', '-b', 'feature']);
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('resolveTestScope: scope selection', () => {
  it('returns scope=full when profile.testing_scope=full', () => {
    seedVitestProject();
    const d = resolveTestScope({
      state: {},
      profile: { testing_scope: 'full', base_branch: 'main' },
      projectRoot,
      baseBranch: 'main',
    }) as Decision;
    expect(d.scope).toBe('full');
    expect(d.adapter).toBe('vitest');
    expect(d.command).toBe('npx vitest run');
    expect(d.reason).toBe('profile_default_full');
    expect(d.fallback).toBe(false);
  });

  it('returns scope=affected with a derived command when diff is non-empty', () => {
    seedVitestProject();
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    git(['add', 'src/a.ts']);
    git(['commit', '-q', '-m', 'add a']);

    const d = resolveTestScope({
      state: { test_files: ['src/a.test.ts'] },
      profile: { testing_scope: 'affected', testing_fallback: 'full', base_branch: 'main' },
      projectRoot,
      baseBranch: 'main',
    }) as Decision;
    expect(d.scope).toBe('affected');
    expect(d.adapter).toBe('vitest');
    expect(d.command).toContain('vitest run --changed origin/main');
    expect(d.command).toContain('src/a.test.ts');
    expect(d.reason).toBe('affected_from_diff');
  });

  it('test_scope_hint.scope=full overrides profile.testing_scope=affected', () => {
    seedVitestProject();
    const d = resolveTestScope({
      state: { test_scope_hint: { scope: 'full' } },
      profile: { testing_scope: 'affected', base_branch: 'main' },
      projectRoot,
      baseBranch: 'main',
    }) as Decision;
    expect(d.scope).toBe('full');
    expect(d.reason).toBe('story_hint_full');
  });

  it('test_scope_hint.include_dirs widens the affected scope', () => {
    seedVitestProject();
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/a.ts'), 'a');
    git(['add', 'src/a.ts']);
    git(['commit', '-q', '-m', 'add a']);
    const d = resolveTestScope({
      state: { test_scope_hint: { include_dirs: ['src/shared/'] } },
      profile: { testing_scope: 'affected', testing_fallback: 'full', base_branch: 'main' },
      projectRoot,
      baseBranch: 'main',
    }) as Decision;
    expect(d.scope).toBe('affected');
    expect(d.reason).toMatch(/^affected_with_hint_dirs/);
  });
});

describe('resolveTestScope: fallback policy', () => {
  it('falls back to full when no adapter can produce an affected command', () => {
    // Generic adapter only; no testing_commands_affected override.
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture' }));
    const d = resolveTestScope({
      state: {},
      profile: { testing_scope: 'affected', testing_fallback: 'full', base_branch: 'main' },
      projectRoot,
      baseBranch: 'main',
    }) as Decision;
    expect(d.scope).toBe('full');
    expect(d.fallback).toBe(true);
    expect(d.reason).toBe('fallback:adapter_no_affected_command');
  });

  it('halt policy returns command=null with fallback_halt reason', () => {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture' }));
    const d = resolveTestScope({
      state: {},
      profile: { testing_scope: 'affected', testing_fallback: 'halt', base_branch: 'main' },
      projectRoot,
      baseBranch: 'main',
    }) as Decision;
    expect(d.scope).toBe('affected');
    expect(d.command).toBeNull();
    expect(d.reason).toMatch(/^fallback_halt/);
    expect(d.fallback).toBe(true);
  });

  it('falls back to full when git diff cannot resolve a base ref', () => {
    seedVitestProject();
    const d = resolveTestScope({
      state: {},
      profile: { testing_scope: 'affected', testing_fallback: 'full', base_branch: 'nonexistent-branch' },
      projectRoot,
      baseBranch: 'nonexistent-branch',
    }) as Decision;
    // git diff with a missing base returns null → downgrade kicks in.
    expect(d.scope).toBe('full');
    expect(d.fallback).toBe(true);
  });
});
