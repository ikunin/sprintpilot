import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import pgg from '../../_Sprintpilot/scripts/post-green-gates.js';

const { listChangedFiles, isTestFile, isJsTsFile, runGate } = pgg as {
  listChangedFiles: (projectRoot: string, override?: string) => string[];
  isTestFile: (p: string) => boolean;
  isJsTsFile: (p: string) => boolean;
  runGate: (
    name: string,
    command: string,
    args: string[],
    projectRoot: string,
  ) => { gate: string; ok: boolean; exit_code: number; stdout: string; stderr: string };
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sp-pgg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('classifiers', () => {
  it('isTestFile recognizes .test and .spec variants', () => {
    expect(isTestFile('foo.test.ts')).toBe(true);
    expect(isTestFile('foo.spec.tsx')).toBe(true);
    expect(isTestFile('foo.test.js')).toBe(true);
    expect(isTestFile('foo.ts')).toBe(false);
  });

  it('isJsTsFile recognizes JS/TS extensions', () => {
    expect(isJsTsFile('foo.ts')).toBe(true);
    expect(isJsTsFile('foo.tsx')).toBe(true);
    expect(isJsTsFile('foo.mts')).toBe(true);
    expect(isJsTsFile('foo.cjs')).toBe(true);
    expect(isJsTsFile('foo.md')).toBe(false);
  });
});

describe('listChangedFiles', () => {
  it('reads override list when --changed-files path provided', () => {
    const p = join(dir, 'changes.txt');
    writeFileSync(p, 'a.ts\nb.tsx\n\n', 'utf8');
    expect(listChangedFiles(dir, p)).toEqual(['a.ts', 'b.tsx']);
  });

  it('returns [] when git command fails in non-repo', () => {
    // dir is not a git repo → expect [].
    const list = listChangedFiles(dir);
    expect(list).toEqual([]);
  });
});

describe('runGate', () => {
  it('reports ok=true on exit 0', () => {
    const r = runGate('echo-test', 'node', ['-e', 'process.exit(0)'], dir);
    expect(r.ok).toBe(true);
    expect(r.exit_code).toBe(0);
  });

  it('reports ok=false on exit non-zero', () => {
    const r = runGate('fail-test', 'node', ['-e', 'process.exit(7)'], dir);
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBe(7);
  });
});
