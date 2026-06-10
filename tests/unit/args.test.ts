import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module without types
import argsMod from '../../_Sprintpilot/lib/runtime/args.js';

const { parseArgs } = argsMod as {
  parseArgs: (
    argv: string[],
    opts?: { booleanFlags?: string[]; positionalActions?: string[]; listFlags?: string[] },
  ) => { opts: Record<string, unknown>; positional: string[]; actions: string[] };
};

describe('parseArgs', () => {
  it('parses --flag value', () => {
    const { opts } = parseArgs(['--file', 'x.lock']);
    expect(opts.file).toBe('x.lock');
  });

  it('parses --flag=value', () => {
    const { opts } = parseArgs(['--file=x.lock']);
    expect(opts.file).toBe('x.lock');
  });

  it('parses short flags', () => {
    const { opts } = parseArgs(['-m', 'hello']);
    expect(opts.m).toBe('hello');
  });

  it('treats boolean flag as true when present without value', () => {
    const { opts } = parseArgs(['--dry-run'], { booleanFlags: ['dry-run'] });
    expect(opts['dry-run']).toBe(true);
  });

  it('does not swallow next flag as value for boolean flags', () => {
    const { opts } = parseArgs(['--dry-run', '--force'], { booleanFlags: ['dry-run', 'force'] });
    expect(opts['dry-run']).toBe(true);
    expect(opts.force).toBe(true);
  });

  it('treats missing value (next is flag) as boolean true', () => {
    const { opts } = parseArgs(['--foo', '--bar', 'val']);
    expect(opts.foo).toBe(true);
    expect(opts.bar).toBe('val');
  });

  it('collects positional args', () => {
    const { positional } = parseArgs(['some-key', '--prefix', 'story/']);
    expect(positional).toEqual(['some-key']);
  });

  it('classifies known actions into actions array', () => {
    const r = parseArgs(['acquire', 'extra'], {
      positionalActions: ['acquire', 'release', 'check', 'status'],
    });
    expect(r.actions).toEqual(['acquire']);
    expect(r.positional).toEqual(['extra']);
  });

  it('sets help flag on -h and --help', () => {
    expect(parseArgs(['-h']).opts.help).toBe(true);
    expect(parseArgs(['--help']).opts.help).toBe(true);
  });

  describe('listFlags', () => {
    it('accumulates a repeated --flag value into an array', () => {
      const { opts } = parseArgs(['--pattern', 'a', '--pattern', 'b', '--pattern', 'c'], {
        listFlags: ['pattern'],
      });
      expect(opts.pattern).toEqual(['a', 'b', 'c']);
    });

    it('accumulates the --flag=value form too', () => {
      const { opts } = parseArgs(['--path=a.ts', '--path=b.ts'], { listFlags: ['path'] });
      expect(opts.path).toEqual(['a.ts', 'b.ts']);
    });

    it('yields a single-element array when a list flag appears once', () => {
      const { opts } = parseArgs(['--pattern', 'only'], { listFlags: ['pattern'] });
      expect(opts.pattern).toEqual(['only']);
    });

    it('does not leak following list-flag values into positionals', () => {
      const { opts, positional } = parseArgs(
        ['grep', '--pattern', 'x', '--path', 'a.ts', '--path', 'b.ts'],
        { listFlags: ['pattern', 'path'] },
      );
      expect(opts.pattern).toEqual(['x']);
      expect(opts.path).toEqual(['a.ts', 'b.ts']);
      expect(positional).toEqual(['grep']);
    });

    it('leaves non-list flags as last-wins (backward compatible)', () => {
      const { opts } = parseArgs(['--root', 'a', '--root', 'b']);
      expect(opts.root).toBe('b');
    });
  });
});
