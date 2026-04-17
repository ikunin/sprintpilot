import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import gitignoreMod from '../../lib/core/gitignore.js';

const { resolveIgnoreFile, addIgnoreEntry } = gitignoreMod as {
  resolveIgnoreFile: (
    projectRoot: string,
  ) => Promise<{ path: string; created: boolean; usedExclude?: boolean }>;
  addIgnoreEntry: (
    ignoreFile: string,
    entry: string,
    opts?: { dryRun?: boolean },
  ) => Promise<{ added: boolean; created: boolean; dryRun?: boolean }>;
};

describe('gitignore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bmad-gi-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it('resolveIgnoreFile prefers existing .gitignore', async () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
    const r = await resolveIgnoreFile(dir);
    expect(r.path).toBe(join(dir, '.gitignore'));
    expect(r.created).toBe(false);
  });

  it('resolveIgnoreFile uses .git/info/exclude when .gitignore absent and exclude non-empty', async () => {
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '# comment\n*.tmp\n', 'utf8');
    const r = await resolveIgnoreFile(dir);
    expect(r.path).toBe(join(dir, '.git', 'info', 'exclude'));
    expect(r.usedExclude).toBe(true);
  });

  it('resolveIgnoreFile returns .gitignore path (created=true) when neither exists', async () => {
    const r = await resolveIgnoreFile(dir);
    expect(r.path).toBe(join(dir, '.gitignore'));
    expect(r.created).toBe(true);
  });

  it('addIgnoreEntry creates a new .gitignore when absent', async () => {
    const target = join(dir, '.gitignore');
    const r = await addIgnoreEntry(target, '.autopilot.lock');
    expect(r.added).toBe(true);
    expect(r.created).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('.autopilot.lock\n');
  });

  it('addIgnoreEntry appends to existing file with trailing newline', async () => {
    const target = join(dir, '.gitignore');
    writeFileSync(target, 'node_modules/\n', 'utf8');
    await addIgnoreEntry(target, '.autopilot.lock');
    expect(readFileSync(target, 'utf8')).toBe('node_modules/\n.autopilot.lock\n');
  });

  it('addIgnoreEntry appends missing newline before entry', async () => {
    const target = join(dir, '.gitignore');
    writeFileSync(target, 'node_modules/', 'utf8');
    await addIgnoreEntry(target, '.autopilot.lock');
    expect(readFileSync(target, 'utf8')).toBe('node_modules/\n.autopilot.lock\n');
  });

  it('addIgnoreEntry is idempotent — no duplicate lines', async () => {
    const target = join(dir, '.gitignore');
    writeFileSync(target, '.autopilot.lock\n', 'utf8');
    const r = await addIgnoreEntry(target, '.autopilot.lock');
    expect(r.added).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('.autopilot.lock\n');
  });

  it('addIgnoreEntry dry-run leaves file untouched', async () => {
    const target = join(dir, '.gitignore');
    writeFileSync(target, 'node_modules/\n', 'utf8');
    const r = await addIgnoreEntry(target, '.autopilot.lock', { dryRun: true });
    expect(r.added).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('node_modules/\n'); // unchanged
  });
});
