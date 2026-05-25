import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS
import { pickAdapter, adapters } from '../../../_Sprintpilot/lib/orchestrator/testing/index.js';

type Adapter = {
  NAME: string;
  detect: (projectRoot: string) => boolean;
  buildCmd: (input: Record<string, unknown>) => string | null;
};

const { vitest, jest, pytest, generic } = adapters as {
  vitest: Adapter; jest: Adapter; pytest: Adapter; generic: Adapter;
};

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sp-testing-adapter-'));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function writePackageJson(deps: Record<string, string>): void {
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', devDependencies: deps }),
  );
}

// posix path normalizer for safe template-string embedding on Windows CI.
const sx = (p: string) => p.replace(/\\/g, '/');

describe('vitest adapter', () => {
  it('detects vitest via package.json devDependency', () => {
    writePackageJson({ vitest: '^3.0.0' });
    expect(vitest.detect(projectRoot)).toBe(true);
  });

  it('detects vitest via config file', () => {
    writeFileSync(join(projectRoot, 'vitest.config.ts'), 'export default {}');
    expect(vitest.detect(projectRoot)).toBe(true);
  });

  it('returns false when neither config nor dep present', () => {
    writePackageJson({ jest: '^29.0.0' });
    expect(vitest.detect(projectRoot)).toBe(false);
  });

  it('builds an affected command with --changed + pinned test files', () => {
    writePackageJson({ vitest: '^3.0.0' });
    const cmd = vitest.buildCmd({
      scope: 'affected',
      changedFiles: ['src/a.ts'],
      testFiles: ['src/a.test.ts'],
      profile: { base_branch: 'main' },
      baseRef: 'main',
    });
    expect(cmd).toContain('vitest run --changed origin/main');
    expect(cmd).toContain('src/a.test.ts');
  });

  it('falls back to bare vitest run for full scope', () => {
    expect(
      vitest.buildCmd({ scope: 'full', profile: {} }),
    ).toBe('npx vitest run');
  });

  it('user override wins over adapter-built command', () => {
    const cmd = vitest.buildCmd({
      scope: 'affected',
      testFiles: [],
      profile: { testing_commands_affected: 'pnpm test:affected' },
    });
    expect(cmd).toBe('pnpm test:affected');
  });
});

describe('jest adapter', () => {
  it('detects jest via package.json devDependency', () => {
    writePackageJson({ jest: '^29.0.0' });
    expect(jest.detect(projectRoot)).toBe(true);
  });

  it('detects jest via package.json `jest` key', () => {
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', jest: { testEnvironment: 'node' } }),
    );
    expect(jest.detect(projectRoot)).toBe(true);
  });

  it('builds --findRelatedTests for affected scope', () => {
    const cmd = jest.buildCmd({
      scope: 'affected',
      changedFiles: ['src/a.js'],
      testFiles: ['src/a.test.js'],
      profile: {},
    });
    expect(cmd).toContain('jest --findRelatedTests');
    expect(cmd).toContain('src/a.js');
    expect(cmd).toContain('src/a.test.js');
  });

  it('falls back to bare jest when no files to relate', () => {
    const cmd = jest.buildCmd({
      scope: 'affected',
      changedFiles: [],
      testFiles: [],
      profile: {},
    });
    expect(cmd).toBe('npx jest');
  });
});

describe('pytest adapter', () => {
  it('detects pytest via pytest.ini', () => {
    writeFileSync(join(projectRoot, 'pytest.ini'), '[pytest]\n');
    expect(pytest.detect(projectRoot)).toBe(true);
  });

  it('detects pytest via pyproject.toml [tool.pytest]', () => {
    writeFileSync(
      join(projectRoot, 'pyproject.toml'),
      '[tool.pytest.ini_options]\nminversion = "8.0"\n',
    );
    expect(pytest.detect(projectRoot)).toBe(true);
  });

  it('uses testmon when .testmondata exists', () => {
    writeFileSync(join(projectRoot, '.testmondata'), '');
    const cmd = pytest.buildCmd({
      scope: 'affected',
      changedFiles: ['src/x.py'],
      testFiles: [],
      profile: {},
      projectRoot,
    });
    expect(cmd).toBe('pytest --testmon');
  });

  it('maps changed source dirs to tests/<dir>/ when no testmon', () => {
    const cmd = pytest.buildCmd({
      scope: 'affected',
      changedFiles: ['src/foo/bar.py', 'src/baz/qux.py'],
      testFiles: ['tests/foo/test_bar.py'],
      profile: {},
      projectRoot,
    });
    expect(cmd).toMatch(/^pytest /);
    expect(cmd).toContain('tests/foo/test_bar.py');
    expect(cmd).toContain('tests/foo/');
  });

  it('falls back to bare pytest when nothing maps', () => {
    const cmd = pytest.buildCmd({
      scope: 'affected',
      changedFiles: [],
      testFiles: [],
      profile: {},
      projectRoot,
    });
    expect(cmd).toBe('pytest');
  });
});

describe('generic adapter', () => {
  it('detect() is always true', () => {
    expect(generic.detect()).toBe(true);
  });

  it('returns user-supplied command when set', () => {
    const cmd = generic.buildCmd({
      scope: 'affected',
      profile: { testing_commands_affected: 'turbo run test --filter=...' },
    });
    expect(cmd).toBe('turbo run test --filter=...');
  });

  it('returns null for affected with no user command (signals fallback)', () => {
    expect(generic.buildCmd({ scope: 'affected', profile: {} })).toBeNull();
  });

  it('returns sensible full default when no override', () => {
    expect(generic.buildCmd({ scope: 'full', profile: {} })).toBe('npm test');
  });
});

describe('pickAdapter registry', () => {
  it('returns vitest for a vitest-only project', () => {
    writePackageJson({ vitest: '^3.0.0' });
    const a = pickAdapter(projectRoot);
    expect(a && a.NAME).toBe('vitest');
  });

  it('returns jest when vitest is absent', () => {
    writePackageJson({ jest: '^29.0.0' });
    expect((pickAdapter(projectRoot) || {}).NAME).toBe('jest');
  });

  it('prefers vitest over jest when both are present', () => {
    writePackageJson({ vitest: '^3.0.0', jest: '^29.0.0' });
    expect((pickAdapter(projectRoot) || {}).NAME).toBe('vitest');
  });

  it('falls through to generic for empty projects', () => {
    expect((pickAdapter(projectRoot) || {}).NAME).toBe('generic');
  });

  it('survives projectRoot = null without throwing', () => {
    expect(() => pickAdapter(null as unknown as string)).not.toThrow();
  });
});

// Touch sx() so the helper isn't dead code when imported by other CI-flake-prone test specs.
void sx;
