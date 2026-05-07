import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// End-to-end test of the merge-driver script via process.argv. Confirms
// that file IO + dispatcher + pure merge primitive work together.

const SCRIPT = path.resolve(
  __dirname,
  '..',
  '..',
  '_Sprintpilot',
  'scripts',
  'auto-merge-bmad-docs.js',
);

function run(aPath: string, oPath: string, bPath: string): { code: number; stderr: string } {
  try {
    execFileSync('node', [SCRIPT, aPath, oPath, bPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { code: err.status ?? 1, stderr: err.stderr?.toString() || '' };
  }
}

describe('auto-merge-bmad-docs (driver entry point)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sp-merge-driver-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges autopilot-state.yaml by latest last_updated', () => {
    const a = path.join(dir, 'autopilot-state.yaml');
    const o = path.join(dir, 'autopilot-state.O.yaml');
    const b = path.join(dir, 'autopilot-state.B.yaml');
    writeFileSync(
      a,
      'last_updated: "2026-04-15T12:00:00Z"\ncurrent_story: "1-1"\n',
    );
    writeFileSync(o, '');
    writeFileSync(
      b,
      'last_updated: "2026-04-15T13:00:00Z"\ncurrent_story: "1-2"\n',
    );
    const r = run(a, o, b);
    expect(r.code).toBe(0);
    expect(readFileSync(a, 'utf8')).toMatch(/current_story: "1-2"/);
  });

  it('exits 1 with stderr when filename is unknown', () => {
    const a = path.join(dir, 'unknown.yaml');
    writeFileSync(a, 'x: 1\n');
    writeFileSync(`${a}.O`, '');
    writeFileSync(`${a}.B`, 'x: 2\n');
    const r = run(a, `${a}.O`, `${a}.B`);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no merger registered/);
    // Source file untouched on refusal.
    expect(readFileSync(a, 'utf8')).toBe('x: 1\n');
  });

  it('exits 1 when shape is unfamiliar (preserves A)', () => {
    const a = path.join(dir, 'decision-log.yaml');
    writeFileSync(a, 'wrong: shape\n');
    writeFileSync(`${a}.O`, '');
    writeFileSync(
      `${a}.B`,
      'last_updated: "2026-04-15T13:00:00Z"\n\ndecisions:\n  - id: "1"\n    ts: "2026-04-15T12:00:00Z"\n',
    );
    const r = run(a, `${a}.O`, `${a}.B`);
    expect(r.code).toBe(1);
    expect(readFileSync(a, 'utf8')).toBe('wrong: shape\n');
  });

  it('merges decision-log.yaml by union of ids', () => {
    const a = path.join(dir, 'decision-log.yaml');
    writeFileSync(
      a,
      `last_updated: "2026-04-15T12:00:00Z"\n\ndecisions:\n  - id: "1"\n    decision: "first"\n    ts: "2026-04-15T10:00:00Z"\n`,
    );
    writeFileSync(`${a}.O`, '');
    writeFileSync(
      `${a}.B`,
      `last_updated: "2026-04-15T13:00:00Z"\n\ndecisions:\n  - id: "2"\n    decision: "second"\n    ts: "2026-04-15T11:00:00Z"\n`,
    );
    const r = run(a, `${a}.O`, `${a}.B`);
    expect(r.code).toBe(0);
    const merged = readFileSync(a, 'utf8');
    expect(merged).toMatch(/id: "1"/);
    expect(merged).toMatch(/id: "2"/);
    expect(merged).toMatch(/last_updated: "2026-04-15T13:00:00Z"/);
  });
});
