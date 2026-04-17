import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import secretsMod from '../../_Sprintpilot/lib/runtime/secrets.js';

const { globToRegex, scanLinesForSecrets, parseAllowlist, isAllowlisted, isBinaryFile } =
  secretsMod as {
    globToRegex: (glob: string) => RegExp;
    scanLinesForSecrets: (text: string, max?: number) => { line: number; text: string }[];
    parseAllowlist: (path: string) => { glob: string; regex: RegExp }[];
    isAllowlisted: (path: string, patterns: { regex: RegExp }[]) => boolean;
    isBinaryFile: (path: string) => boolean;
  };

describe('globToRegex', () => {
  it('matches simple star', () => {
    expect(globToRegex('*.js').test('foo.js')).toBe(true);
    expect(globToRegex('*.js').test('foo.ts')).toBe(false);
  });

  it('star does NOT match slashes', () => {
    expect(globToRegex('*.js').test('a/b.js')).toBe(false);
  });

  it('double star matches across directories', () => {
    expect(globToRegex('test/**').test('test/a/b.js')).toBe(true);
    expect(globToRegex('test/**').test('test/a.js')).toBe(true);
  });

  it('double star at start matches anything with suffix', () => {
    expect(globToRegex('**/test_*').test('a/b/test_foo.js')).toBe(true);
    expect(globToRegex('**/test_*').test('test_foo.js')).toBe(true);
  });

  it('question mark matches one char, not slash', () => {
    expect(globToRegex('?.js').test('a.js')).toBe(true);
    expect(globToRegex('?.js').test('ab.js')).toBe(false);
    expect(globToRegex('?.js').test('/.js')).toBe(false);
  });

  it('character class works', () => {
    expect(globToRegex('[ab].js').test('a.js')).toBe(true);
    expect(globToRegex('[ab].js').test('c.js')).toBe(false);
  });

  it('escapes regex metacharacters in literal text', () => {
    expect(globToRegex('.env.example').test('.env.example')).toBe(true);
    expect(globToRegex('.env.example').test('xenvxexample')).toBe(false);
  });
});

describe('scanLinesForSecrets', () => {
  it('finds API_KEY pattern', () => {
    const text = 'ok\nAPI_KEY=abc\ndone';
    const hits = scanLinesForSecrets(text);
    expect(hits.length).toBe(1);
    expect(hits[0].line).toBe(2);
  });

  it('finds multiple secret patterns', () => {
    const text = 'PASSWORD=\nSECRET=\nTOKEN=\n';
    const hits = scanLinesForSecrets(text);
    expect(hits.length).toBe(3);
  });

  it('stops at max hits', () => {
    const text = Array.from({ length: 10 }, () => 'API_KEY=x').join('\n');
    const hits = scanLinesForSecrets(text, 2);
    expect(hits.length).toBe(2);
  });

  it('is case-insensitive (matches aws_access)', () => {
    expect(scanLinesForSecrets('aws_access=1\n').length).toBe(1);
  });

  it('returns empty for clean text', () => {
    expect(scanLinesForSecrets('function foo() { return 42; }\n').length).toBe(0);
  });

  // Regression: real-world secret formats must be caught even without a
  // keyword like API_KEY on the same line.
  // Prefixes assembled at runtime to avoid triggering upstream secret scanners
  // (GitHub push protection, etc.) on obviously synthetic test fixtures.
  const stripeLivePrefix = 'sk_' + 'live_';
  it.each([
    'AKIAIOSFODNN7EXAMPLE', // AWS access key id
    'ghp_1234567890abcdef1234567890abcdef1234', // GitHub PAT
    'sk-abc123xyz456abc123xyz456abc123', // OpenAI-like
    stripeLivePrefix + 'EXAMPLEEXAMPLEEXAMPLEEXAMPLE', // Stripe live (synthetic)
    'xoxb-123456789012-1234567890123-abcdefghijklm', // Slack bot
    'AIzaSyA1234567890abcdefghij1234567890abc', // Google API key (39 chars)
    '-----BEGIN RSA PRIVATE KEY-----', // PEM header
  ])('catches concrete secret format: %s', (blob) => {
    expect(scanLinesForSecrets(blob).length).toBeGreaterThan(0);
  });
});

describe('allowlist parsing and matching', () => {
  let tempFile: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'sprintpilot-secrets-'));
    tempFile = join(dir, 'allowlist');
  });
  afterEach(() => {
    try {
      rmSync(tempFile, { force: true });
    } catch {
      /* */
    }
  });

  it('parses patterns, skips comments and blanks', () => {
    writeFileSync(tempFile, `# comment\n\ntests/**\n*.example\n  *.md  \n`, 'utf8');
    const p = parseAllowlist(tempFile);
    expect(p.map((x) => x.glob)).toEqual(['tests/**', '*.example', '*.md']);
  });

  it('isAllowlisted matches via glob', () => {
    writeFileSync(tempFile, 'tests/**\n**/fixtures/**\n*.example\n', 'utf8');
    const patterns = parseAllowlist(tempFile);
    expect(isAllowlisted('tests/foo.js', patterns)).toBe(true);
    expect(isAllowlisted('src/fixtures/x.json', patterns)).toBe(true);
    expect(isAllowlisted('.env.example', patterns)).toBe(true);
    expect(isAllowlisted('src/prod.js', patterns)).toBe(false);
  });

  it('returns empty array when file is missing', () => {
    expect(parseAllowlist('/nonexistent/path')).toEqual([]);
  });
});

describe('isBinaryFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sprintpilot-bin-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it('detects NUL bytes as binary', () => {
    const f = join(dir, 'x.bin');
    writeFileSync(f, Buffer.from([0x00, 0x01, 0x02]));
    expect(isBinaryFile(f)).toBe(true);
  });

  it('accepts text as non-binary', () => {
    const f = join(dir, 'x.txt');
    writeFileSync(f, 'hello world\n', 'utf8');
    expect(isBinaryFile(f)).toBe(false);
  });

  it('empty file is not binary', () => {
    const f = join(dir, 'empty.txt');
    writeFileSync(f, '', 'utf8');
    expect(isBinaryFile(f)).toBe(false);
  });
});
