import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS
import { adapters, pickAdapter } from '../../../_Sprintpilot/lib/orchestrator/testing/index.js';

type Adapter = {
  NAME: string;
  detect: (projectRoot: string) => boolean;
  buildCmd: (input: Record<string, unknown>) => string | null;
};

const { vitest, jest, pytest, generic } = adapters as {
  vitest: Adapter;
  jest: Adapter;
  pytest: Adapter;
  generic: Adapter;
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
    expect(vitest.buildCmd({ scope: 'full', profile: {} })).toBe('npx vitest run');
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
    expect(a?.NAME).toBe('vitest');
  });

  it('returns jest when vitest is absent', () => {
    writePackageJson({ jest: '^29.0.0' });
    expect(pickAdapter(projectRoot)?.NAME).toBe('jest');
  });

  it('prefers vitest over jest when both are present', () => {
    writePackageJson({ vitest: '^3.0.0', jest: '^29.0.0' });
    expect(pickAdapter(projectRoot)?.NAME).toBe('vitest');
  });

  it('falls through to generic for empty projects', () => {
    expect(pickAdapter(projectRoot)?.NAME).toBe('generic');
  });

  it('survives projectRoot = null without throwing', () => {
    expect(() => pickAdapter(null as unknown as string)).not.toThrow();
  });
});

// Touch sx() so the helper isn't dead code when imported by other CI-flake-prone test specs.
void sx;

describe('adapter.buildExcludeFlags — v2.4.0 quarantine', () => {
  const vitestAdapter = vitest as Adapter & { buildExcludeFlags: (ids: string[]) => string };
  const jestAdapter = jest as Adapter & { buildExcludeFlags: (ids: string[]) => string };
  const pytestAdapter = pytest as Adapter & { buildExcludeFlags: (ids: string[]) => string };
  const genericAdapter = generic as Adapter & { buildExcludeFlags: (ids: string[]) => string };

  describe('vitest', () => {
    it('returns "" for no IDs', () => {
      expect(vitestAdapter.buildExcludeFlags([])).toBe('');
    });
    it('emits one --exclude per path-shaped ID', () => {
      const r = vitestAdapter.buildExcludeFlags([
        'tests/flaky.test.ts',
        'src/integration/foo.spec.ts',
      ]);
      expect(r).toContain('--exclude tests/flaky.test.ts');
      expect(r).toContain('--exclude src/integration/foo.spec.ts');
    });
    it('drops name-shaped IDs', () => {
      expect(vitestAdapter.buildExcludeFlags(['some flaky describe > it'])).toBe('');
    });
  });

  describe('jest', () => {
    it('returns "" for no IDs', () => {
      expect(jestAdapter.buildExcludeFlags([])).toBe('');
    });
    it('OR-joins path IDs into a single --testPathIgnorePatterns', () => {
      const r = jestAdapter.buildExcludeFlags(['tests/flaky.test.ts', 'tests/other.test.ts']);
      expect(r.startsWith('--testPathIgnorePatterns ')).toBe(true);
      // Both paths appear in the OR-joined regex (escaped dots).
      expect(r).toContain('tests/flaky\\.test\\.ts');
      expect(r).toContain('tests/other\\.test\\.ts');
      expect(r).toContain('|');
    });
  });

  describe('pytest', () => {
    it('uses --deselect for node IDs and --ignore= for plain paths', () => {
      const r = pytestAdapter.buildExcludeFlags(['tests/flaky.py::test_x', 'tests/legacy.py']);
      expect(r).toContain('--deselect tests/flaky.py::test_x');
      expect(r).toContain('--ignore=tests/legacy.py');
    });
    it('drops non-path non-nodeid IDs', () => {
      expect(pytestAdapter.buildExcludeFlags(['just a string'])).toBe('');
    });
  });

  describe('generic', () => {
    it('returns "" for everything (no portable exclusion)', () => {
      expect(genericAdapter.buildExcludeFlags(['tests/flaky.test.ts'])).toBe('');
    });
  });

  describe('buildCmd integration', () => {
    it('vitest appends exclude flags to the full command', () => {
      const cmd = vitestAdapter.buildCmd({
        scope: 'full',
        profile: {},
        excludeTestIds: ['tests/flaky.test.ts'],
      });
      expect(cmd).toContain('npx vitest run');
      expect(cmd).toContain('--exclude tests/flaky.test.ts');
    });
    it('jest appends exclude flags to the affected command', () => {
      const cmd = jestAdapter.buildCmd({
        scope: 'affected',
        changedFiles: ['src/foo.ts'],
        testFiles: [],
        profile: {},
        excludeTestIds: ['tests/flaky.test.ts'],
      });
      expect(cmd).toContain('--findRelatedTests');
      expect(cmd).toContain('--testPathIgnorePatterns');
    });
  });
});

describe('adapter.buildCmd verbose flag — v2.4.1 diagnostic mode', () => {
  const vitestAdapter = vitest as Adapter;
  const jestAdapter = jest as Adapter;
  const pytestAdapter = pytest as Adapter;

  it('vitest appends --reporter=verbose when verbose is set', () => {
    const cmd = vitestAdapter.buildCmd({ scope: 'full', profile: {}, verbose: true });
    expect(cmd).toContain('--reporter=verbose');
  });

  it('vitest omits verbose flag by default', () => {
    const cmd = vitestAdapter.buildCmd({ scope: 'full', profile: {} });
    expect(cmd).not.toContain('--reporter=verbose');
  });

  it('jest appends --verbose when verbose is set', () => {
    const cmd = jestAdapter.buildCmd({
      scope: 'affected',
      changedFiles: ['src/a.ts'],
      testFiles: [],
      profile: {},
      verbose: true,
    });
    expect(cmd).toContain('--verbose');
  });

  it('pytest appends -v --tb=long when verbose is set', () => {
    const cmd = pytestAdapter.buildCmd({
      scope: 'full',
      profile: {},
      verbose: true,
    });
    expect(cmd).toContain('-v');
    expect(cmd).toContain('--tb=long');
  });

  it('verbose combines with exclude flags', () => {
    const cmd = vitestAdapter.buildCmd({
      scope: 'full',
      profile: {},
      verbose: true,
      excludeTestIds: ['tests/flaky.test.ts'],
    });
    expect(cmd).toContain('--reporter=verbose');
    expect(cmd).toContain('--exclude tests/flaky.test.ts');
  });
});
