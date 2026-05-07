import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// @ts-expect-error — CommonJS module
import lintMod from '../../_Sprintpilot/scripts/lint-test-pitfalls.js';

const {
  classifyFile,
  TEST_FILE_RE,
  parsePatternBundle,
  compilePattern,
  fileMatchesPattern,
  lintFile,
  discoverTestFiles,
} = lintMod as {
  classifyFile: (p: string) => string | null;
  TEST_FILE_RE: RegExp;
  parsePatternBundle: (text: string) => Array<Record<string, string>>;
  compilePattern: (p: Record<string, unknown>) => Record<string, unknown>;
  fileMatchesPattern: (text: string, pat: Record<string, unknown>) => { line: number; snippet: string } | null;
  lintFile: (filePath: string, patterns: Record<string, unknown>[]) => Array<Record<string, unknown>>;
  discoverTestFiles: (rootDir: string, explicit: string[]) => string[];
};

describe('classifyFile', () => {
  it('detects each supported language by extension', () => {
    expect(classifyFile('/x/foo.py')).toBe('python');
    expect(classifyFile('/x/foo.js')).toBe('js-ts');
    expect(classifyFile('/x/foo.tsx')).toBe('js-ts');
    expect(classifyFile('/x/foo.go')).toBe('go');
    expect(classifyFile('/x/foo.rs')).toBe('rust');
    expect(classifyFile('/x/foo.rb')).toBe('ruby');
  });

  it('returns null for unsupported extensions', () => {
    expect(classifyFile('/x/foo.txt')).toBe(null);
    expect(classifyFile('/x/foo')).toBe(null);
  });
});

describe('TEST_FILE_RE', () => {
  it('matches common test-file conventions', () => {
    expect(TEST_FILE_RE.test('foo.test.ts')).toBe(true);
    expect(TEST_FILE_RE.test('foo.spec.tsx')).toBe(true);
    expect(TEST_FILE_RE.test('handler_test.go')).toBe(true);
    expect(TEST_FILE_RE.test('test_handler.py')).toBe(true);
    expect(TEST_FILE_RE.test('user_spec.rb')).toBe(true);
  });

  it('rejects non-test sources', () => {
    expect(TEST_FILE_RE.test('foo.ts')).toBe(false);
    expect(TEST_FILE_RE.test('handler.go')).toBe(false);
  });
});

describe('parsePatternBundle', () => {
  it('parses the default-bundle shape', () => {
    const text = `
patterns:
  - id: foo
    lang: python
    grep: 'with TestClient\\('
    message: "trigger lifespan"
  - id: bar
    lang: js-ts
    grep: 'beforeAll'
    not_grep: 'afterAll'
    message: "missing cleanup"
    severity: warning
`;
    const patterns = parsePatternBundle(text);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].id).toBe('foo');
    expect(patterns[0].lang).toBe('python');
    expect(patterns[0].grep).toBe('with TestClient\\(');
    expect(patterns[0].message).toBe('trigger lifespan');
    expect(patterns[1].id).toBe('bar');
    expect(patterns[1].not_grep).toBe('afterAll');
  });

  it('skips comment lines and blank lines', () => {
    const text = `
# top comment
patterns:
  # mid comment
  - id: only
    lang: python
    grep: 'x'
    message: "hi"

`;
    expect(parsePatternBundle(text)).toEqual([
      { id: 'only', lang: 'python', grep: 'x', message: 'hi' },
    ]);
  });
});

describe('compilePattern + fileMatchesPattern', () => {
  it('matches a regex on a single line', () => {
    const pat = compilePattern({ id: 'foo', grep: 'with TestClient' });
    const hit = fileMatchesPattern(
      'def test_x():\n    with TestClient(app) as c:\n        pass\n',
      pat,
    );
    expect(hit).not.toBe(null);
    expect(hit?.line).toBe(2);
  });

  it('honors not_grep to suppress when cleanup is present', () => {
    const pat = compilePattern({
      id: 'foo',
      grep: 'beforeAll',
      not_grep: 'afterAll',
    });
    const matched = fileMatchesPattern(
      'beforeAll(() => { open(); });\nafterAll(() => { close(); });\n',
      pat,
    );
    expect(matched).toBe(null);
  });

  it('flags a bad regex without throwing', () => {
    const pat = compilePattern({ id: 'bad', grep: '(' });
    expect(pat._error).toBeTruthy();
    expect(pat._compiled).toBe(false);
  });

  it('handles patterns without grep (no-op)', () => {
    const pat = compilePattern({ id: 'noop' });
    expect(fileMatchesPattern('anything', pat)).toBe(null);
  });
});

describe('lintFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sp-lint-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits one finding per matching pattern', () => {
    const file = path.join(dir, 'test_x.py');
    writeFileSync(file, 'def test_x():\n    with TestClient(app) as c:\n        pass\n');
    const patterns = [
      compilePattern({
        id: 'fastapi-lifecycle',
        lang: 'python',
        grep: 'with TestClient\\(',
        message: 'lifespan triggers',
      }),
    ];
    const findings = lintFile(file, patterns);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'fastapi-lifecycle',
      lang: 'python',
      severity: 'warning',
      line: 2,
    });
  });

  it('skips patterns whose lang does not match the file', () => {
    const file = path.join(dir, 'test_x.py');
    writeFileSync(file, 'with TestClient(app)\n');
    const patterns = [
      compilePattern({ id: 'jsts', lang: 'js-ts', grep: 'TestClient' }),
    ];
    expect(lintFile(file, patterns)).toEqual([]);
  });

  it('returns no findings for an unsupported file extension', () => {
    const file = path.join(dir, 'README.md');
    writeFileSync(file, 'with TestClient(app)\n');
    const patterns = [compilePattern({ id: 'x', lang: 'python', grep: 'TestClient' })];
    expect(lintFile(file, patterns)).toEqual([]);
  });
});

describe('discoverTestFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sp-discover-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds files in canonical test dirs', () => {
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    writeFileSync(path.join(dir, 'tests', 'a.py'), '');
    writeFileSync(path.join(dir, 'tests', 'b.ts'), '');
    writeFileSync(path.join(dir, 'src.py'), ''); // outside tests/
    const found = discoverTestFiles(dir, []);
    const rels = found.map((f) => path.relative(dir, f)).sort();
    expect(rels).toContain(path.join('tests', 'a.py'));
    expect(rels).toContain(path.join('tests', 'b.ts'));
  });

  it('finds loose-file test conventions outside test dirs', () => {
    writeFileSync(path.join(dir, 'handler_test.go'), '');
    writeFileSync(path.join(dir, 'login.test.ts'), '');
    writeFileSync(path.join(dir, 'plain.ts'), ''); // not a test file
    const found = discoverTestFiles(dir, []).map((f) => path.relative(dir, f)).sort();
    expect(found).toContain('handler_test.go');
    expect(found).toContain('login.test.ts');
    expect(found).not.toContain('plain.ts');
  });

  it('skips heavy directories like node_modules', () => {
    mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.test.ts'), '');
    writeFileSync(path.join(dir, 'real.test.ts'), '');
    const found = discoverTestFiles(dir, []).map((f) => path.relative(dir, f));
    expect(found).toContain('real.test.ts');
    expect(found.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('honors explicit test-dir arguments', () => {
    mkdirSync(path.join(dir, 'mytests'), { recursive: true });
    writeFileSync(path.join(dir, 'mytests', 'a.py'), '');
    const found = discoverTestFiles(dir, ['mytests']).map((f) => path.relative(dir, f));
    expect(found).toContain(path.join('mytests', 'a.py'));
  });
});
