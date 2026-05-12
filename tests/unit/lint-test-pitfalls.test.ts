import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import lint from '../../_Sprintpilot/scripts/lint-test-pitfalls.js';

const { scanFile } = lint as {
  scanFile: (filePath: string) => {
    file: string;
    issues: { id: string; severity: string; line: number; message: string; match: string }[];
  };
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sp-lint-pitfalls-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('lint-test-pitfalls.scanFile', () => {
  it('flags it.only', () => {
    const p = write('t.test.ts', 'it.only("x", () => {});\n');
    const r = scanFile(p);
    expect(r.issues.some((i) => i.id === 'focused_or_skipped')).toBe(true);
  });

  it('flags describe.only', () => {
    const p = write('t.test.ts', 'describe.only("x", () => {});\n');
    const r = scanFile(p);
    expect(r.issues.some((i) => i.id === 'focused_or_skipped')).toBe(true);
  });

  it('flags xit / xdescribe', () => {
    const p = write('t.test.ts', 'xit("x", () => {});\nxdescribe("y", () => {});\n');
    const r = scanFile(p);
    const ids = r.issues.filter((i) => i.id === 'focused_or_skipped').length;
    expect(ids).toBe(2);
  });

  it('flags tautological expect(true).toBe(true)', () => {
    const p = write('t.test.ts', 'expect(true).toBe(true);\n');
    const r = scanFile(p);
    expect(r.issues.some((i) => i.id === 'tautological_expect')).toBe(true);
  });

  it('flags process.exit in test source', () => {
    const p = write('t.test.ts', 'process.exit(0);\n');
    const r = scanFile(p);
    expect(r.issues.some((i) => i.id === 'process_exit_in_test')).toBe(true);
  });

  it('flags hardcoded /tmp paths', () => {
    const p = write('t.test.ts', 'const x = "/tmp/foo";\n');
    const r = scanFile(p);
    expect(r.issues.some((i) => i.id === 'hardcoded_absolute_path')).toBe(true);
  });

  it('flags hardcoded Windows paths', () => {
    const p = write('t.test.ts', 'const x = "C:\\\\foo\\\\bar";\n');
    const r = scanFile(p);
    expect(r.issues.some((i) => i.id === 'hardcoded_absolute_path')).toBe(true);
  });

  it('reports line numbers', () => {
    const p = write('t.test.ts', 'line1\nline2\nit.only("x", () => {});\n');
    const r = scanFile(p);
    const focused = r.issues.find((i) => i.id === 'focused_or_skipped');
    expect(focused?.line).toBe(3);
  });

  it('returns empty issues for clean file', () => {
    const p = write(
      't.test.ts',
      'import { it, expect } from "vitest";\nit("ok", () => { expect(2 + 2).toBe(4); });\n',
    );
    const r = scanFile(p);
    expect(r.issues).toEqual([]);
  });

  it('returns error for unreadable file', () => {
    const r = scanFile(join(dir, 'nope.ts')) as { error?: string };
    expect(r.error).toBeDefined();
  });
});
