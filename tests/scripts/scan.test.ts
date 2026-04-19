import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScript } from './helpers/run.js';

interface TempTree {
  dir: string;
  cleanup: () => void;
  write: (rel: string, body?: string) => void;
  link: (from: string, to: string) => void;
}

function createTempTree(): TempTree {
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* */
      }
    },
    write(rel: string, body = 'line\n') {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    },
    link(from: string, to: string) {
      symlinkSync(to, join(dir, from));
    },
  };
}

describe('scan.js', () => {
  let tree: TempTree;
  beforeEach(() => {
    tree = createTempTree();
  });
  afterEach(() => {
    tree.cleanup();
  });

  describe('files subcommand', () => {
    it('counts files matching a basename glob at any depth', () => {
      tree.write('a.ts');
      tree.write('nested/b.ts');
      tree.write('deep/deeper/c.ts');
      tree.write('d.py'); // excluded by include
      const r = runScript('scan', ['files', '--include', '*.ts', '--root', tree.dir, '--count']);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('3');
    });

    it('exclude pattern without leading / applies at any depth (round-1 fix #1)', () => {
      tree.write('a.ts');
      tree.write('a.test.ts');
      tree.write('nested/b.test.ts');
      tree.write('deep/c.test.ts');
      const r = runScript('scan', [
        'files',
        '--include',
        '*.ts',
        '--exclude',
        '*.test.*',
        '--root',
        tree.dir,
        '--count',
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('1');
    });

    it('honors brace alternations in --include', () => {
      tree.write('a.ts');
      tree.write('b.js');
      tree.write('c.py');
      const r = runScript('scan', [
        'files',
        '--include',
        '*.{ts,js}',
        '--root',
        tree.dir,
        '--count',
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('2');
    });

    it('handles nested brace alternations', () => {
      tree.write('a.ts');
      tree.write('b.test.ts');
      tree.write('c.spec.ts');
      const r = runScript('scan', [
        'files',
        '--include',
        '*.{ts,{test,spec}.ts}',
        '--root',
        tree.dir,
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout.split('\n').sort()).toEqual(['a.ts', 'b.test.ts', 'c.spec.ts']);
    });

    it('anchored glob with / does NOT fall back to basename', () => {
      tree.write('src/a.ts');
      tree.write('lib/src-bak/a.ts');
      tree.write('a.ts');
      const r = runScript('scan', ['files', '--include', 'src/*.ts', '--root', tree.dir]);
      expect(r.status).toBe(0);
      expect(r.stdout.split('\n').sort()).toEqual(['src/a.ts']);
    });

    it('auto-excludes node_modules and .git', () => {
      tree.write('a.ts');
      tree.write('node_modules/pkg/index.ts');
      tree.write('.git/objects/x.ts');
      const r = runScript('scan', ['files', '--include', '*.ts', '--root', tree.dir]);
      expect(r.stdout.split('\n').sort()).toEqual(['a.ts']);
    });

    it('follows symlinked files within the root (round-1 fix #2)', () => {
      tree.write('real.ts');
      tree.link('alias.ts', join(tree.dir, 'real.ts'));
      const r = runScript('scan', ['files', '--include', '*.ts', '--root', tree.dir, '--count']);
      expect(r.stdout).toBe('2');
    });

    it('refuses to follow symlinks that escape --root (round-2 fix #1)', () => {
      const outside = mkdtempSync(join(tmpdir(), 'scan-outside-'));
      try {
        writeFileSync(join(outside, 'external.ts'), 'x');
        tree.write('real.ts');
        tree.link('escape', outside);
        const r = runScript('scan', ['files', '--include', '*.ts', '--root', tree.dir]);
        expect(r.stdout.split('\n').sort()).toEqual(['real.ts']);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('breaks symlink cycles', () => {
      tree.write('a.ts');
      tree.link('loop', tree.dir);
      const r = runScript('scan', ['files', '--include', '*.ts', '--root', tree.dir, '--count']);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('1');
    });

    it('--limit caps output', () => {
      for (let i = 0; i < 5; i++) tree.write(`file${i}.ts`);
      const r = runScript('scan', ['files', '--include', '*.ts', '--root', tree.dir, '--limit', '2']);
      expect(r.stdout.split('\n')).toHaveLength(2);
    });
  });

  describe('largest subcommand', () => {
    it('ranks files by line count descending', () => {
      tree.write('small.ts', 'a\n');
      tree.write('medium.ts', 'a\nb\nc\n');
      tree.write('big.ts', 'a\nb\nc\nd\ne\n');
      const r = runScript('scan', [
        'largest',
        '--include',
        '*.ts',
        '--root',
        tree.dir,
        '--limit',
        '3',
      ]);
      expect(r.status).toBe(0);
      const lines = r.stdout.split('\n');
      expect(lines[0]).toBe('5\tbig.ts');
      expect(lines[1]).toBe('3\tmedium.ts');
      expect(lines[2]).toBe('1\tsmall.ts');
    });

    it('counts final line without trailing newline', () => {
      tree.write('no-trailing.ts', 'a\nb\nc'); // 3 lines
      tree.write('trailing.ts', 'a\nb\nc\n'); // 3 lines
      const r = runScript('scan', ['largest', '--include', '*.ts', '--root', tree.dir]);
      const lines = r.stdout.split('\n');
      expect(lines[0]).toMatch(/^3\t/);
      expect(lines[1]).toMatch(/^3\t/);
    });

    it('empty file returns 0 lines', () => {
      tree.write('empty.ts', '');
      const r = runScript('scan', ['largest', '--include', '*.ts', '--root', tree.dir]);
      expect(r.stdout).toBe('0\tempty.ts');
    });
  });

  describe('loc subcommand', () => {
    it('emits total-lines and file-count tab-separated', () => {
      tree.write('a.ts', 'x\ny\n');
      tree.write('b.ts', 'x\ny\nz\n');
      const r = runScript('scan', ['loc', '--include', '*.ts', '--root', tree.dir]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('5\t2');
    });
  });

  describe('extensions subcommand', () => {
    it('produces a descending histogram', () => {
      tree.write('a.ts');
      tree.write('b.ts');
      tree.write('c.ts');
      tree.write('d.js');
      tree.write('e.md');
      const r = runScript('scan', ['extensions', '--root', tree.dir]);
      const lines = r.stdout.split('\n');
      expect(lines[0]).toBe('3\tts');
      expect(lines.slice(1).sort()).toEqual(['1\tjs', '1\tmd']);
    });
  });

  describe('error handling', () => {
    it('exits 1 with no subcommand', () => {
      const r = runScript('scan', []);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('Usage:');
    });

    it('exits 1 on unknown subcommand', () => {
      const r = runScript('scan', ['bogus']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Unknown subcommand');
    });

    it('fails on missing root', () => {
      const r = runScript('scan', ['files', '--root', '/definitely-does-not-exist-xyzzy']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('does not exist');
    });

    it('--help prints usage and exits 0', () => {
      const r = runScript('scan', ['--help']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage:');
    });
  });
});
