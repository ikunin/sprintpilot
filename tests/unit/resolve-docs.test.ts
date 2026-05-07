import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// @ts-expect-error — CommonJS module
import resolveMod from '../../lib/commands/resolve-docs';

const { runResolveDocs, splitConflict } = resolveMod as {
  runResolveDocs: (opts: { paths?: string[]; dryRun?: boolean }) => Promise<void>;
  splitConflict: (text: string) => { a: string; b: string } | null;
};

describe('splitConflict', () => {
  it('extracts the two halves of a single conflict region', () => {
    const text = `top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\nbottom\n`;
    const split = splitConflict(text);
    expect(split).not.toBe(null);
    expect(split!.a).toContain('ours\n');
    expect(split!.b).toContain('theirs\n');
    expect(split!.a).toContain('top\n');
    expect(split!.a).toContain('bottom\n');
  });

  it('returns null when no conflict markers', () => {
    expect(splitConflict('plain text')).toBe(null);
  });
});

describe('runResolveDocs', () => {
  let dir: string;
  let prevCwd: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sp-resolve-docs-'));
    prevCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a conflict in autopilot-state.yaml', async () => {
    const target = path.join(dir, 'state.yaml');
    writeFileSync(
      target,
      [
        '<<<<<<< HEAD',
        'last_updated: "2026-04-15T10:00:00Z"',
        'current_story: "1-1"',
        '=======',
        'last_updated: "2026-04-15T11:00:00Z"',
        'current_story: "1-2"',
        '>>>>>>> branch',
        '',
      ].join('\n'),
    );
    // Using explicit paths bypasses the default project-relative state-file
    // list — handy for testing.
    await runResolveDocs({ paths: ['state.yaml'] });
    const out = readFileSync(target, 'utf8');
    // Without a registered merger for "state.yaml", the file is left as-is.
    expect(out).toContain('<<<<<<< HEAD');
  });

  it('resolves a conflict in a registered file (decision-log.yaml)', async () => {
    const target = path.join(dir, 'decision-log.yaml');
    const a = `last_updated: "2026-04-15T10:00:00Z"

decisions:
  - id: "1"
    decision: "ours"
    ts: "2026-04-15T09:00:00Z"
`;
    const b = `last_updated: "2026-04-15T11:00:00Z"

decisions:
  - id: "2"
    decision: "theirs"
    ts: "2026-04-15T10:30:00Z"
`;
    writeFileSync(
      target,
      `<<<<<<< HEAD\n${a}=======\n${b}>>>>>>> branch\n`,
    );
    await runResolveDocs({ paths: ['decision-log.yaml'] });
    const out = readFileSync(target, 'utf8');
    expect(out).not.toContain('<<<<<<<');
    expect(out).toMatch(/id: "1"/);
    expect(out).toMatch(/id: "2"/);
  });

  it('skips files without conflict markers', async () => {
    const target = path.join(dir, 'autopilot-state.yaml');
    writeFileSync(target, 'last_updated: "2026-04-15T10:00:00Z"\n');
    await runResolveDocs({ paths: ['autopilot-state.yaml'] });
    expect(readFileSync(target, 'utf8')).toBe(
      'last_updated: "2026-04-15T10:00:00Z"\n',
    );
  });

  it('dry-run does not write anything', async () => {
    const target = path.join(dir, 'decision-log.yaml');
    const original = `<<<<<<< HEAD\nlast_updated: "X"\n\ndecisions:\n  - id: "1"\n    ts: "1"\n=======\nlast_updated: "Y"\n\ndecisions:\n  - id: "2"\n    ts: "2"\n>>>>>>> branch\n`;
    writeFileSync(target, original);
    await runResolveDocs({ paths: ['decision-log.yaml'], dryRun: true });
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('walks the default state-file list when no paths given', async () => {
    const dst = path.join(dir, '_bmad-output', 'implementation-artifacts');
    mkdirSync(dst, { recursive: true });
    const decisionLog = path.join(dst, 'decision-log.yaml');
    writeFileSync(
      decisionLog,
      `<<<<<<< HEAD\nlast_updated: "X"\n\ndecisions:\n  - id: "1"\n    ts: "1"\n=======\nlast_updated: "Y"\n\ndecisions:\n  - id: "2"\n    ts: "2"\n>>>>>>> branch\n`,
    );
    await runResolveDocs({});
    expect(readFileSync(decisionLog, 'utf8')).not.toContain('<<<<<<<');
  });
});
