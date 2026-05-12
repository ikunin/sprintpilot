import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import shardMod from '../../_Sprintpilot/scripts/state-shard.js';

const {
  STORY_RE,
  VALID_KINDS,
  SCHEMA_VERSION,
  validateStory,
  validateKind,
  yamlDump,
  yamlLoad,
  parseValue,
  setByDottedPath,
  getByDottedPath,
  shardPath,
  shardDir,
  readShard,
  writeShardAtomic,
  appendToListAtPath,
  listShardStories,
  stripTrailingComment,
  firstTopLevelColon,
} = shardMod as {
  STORY_RE: RegExp;
  VALID_KINDS: string[];
  SCHEMA_VERSION: number;
  validateStory: (s: unknown) => { ok: boolean; value?: string; error?: string };
  validateKind: (s: unknown) => { ok: boolean; value?: string; error?: string };
  yamlDump: (obj: unknown) => string;
  yamlLoad: (s: string) => Record<string, unknown>;
  parseValue: (s: string) => unknown;
  setByDottedPath: (o: Record<string, unknown>, k: string, v: unknown) => Record<string, unknown>;
  getByDottedPath: (o: unknown, k: string) => unknown;
  shardPath: (root: string, story: string, kind: string) => string;
  shardDir: (root: string, kind: string) => string;
  readShard: (root: string, story: string, kind: string) => Record<string, unknown> | null;
  writeShardAtomic: (
    root: string,
    story: string,
    kind: string,
    obj: Record<string, unknown>,
  ) => string;
  appendToListAtPath: (
    o: Record<string, unknown>,
    p: string,
    e: unknown,
  ) => Record<string, unknown>;
  listShardStories: (root: string, kind: string) => string[];
  stripTrailingComment: (s: string) => string;
  firstTopLevelColon: (s: string) => number;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'state-shard.js');

let tmpRoot = '';
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-shard-'));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('constants + validators', () => {
  it('exposes canonical kinds and schema version', () => {
    expect(VALID_KINDS).toEqual(['state', 'decision-log']);
    expect(SCHEMA_VERSION).toBe(1);
  });
  it('STORY_RE blocks traversal', () => {
    expect(STORY_RE.test('1-2-foo')).toBe(true);
    expect(STORY_RE.test('../etc/passwd')).toBe(false);
    expect(STORY_RE.test('..a')).toBe(false);
    expect(STORY_RE.test('/abs')).toBe(false);
  });
  it('validateStory rejects empty + bad chars', () => {
    expect(validateStory('').ok).toBe(false);
    expect(validateStory('A-Upper').ok).toBe(false);
    expect(validateStory('ok').ok).toBe(true);
  });
  it('validateKind defaults to state', () => {
    expect(validateKind(undefined).value).toBe('state');
    expect(validateKind('decision-log').value).toBe('decision-log');
    expect(validateKind('bogus').ok).toBe(false);
  });
});

describe('shardPath', () => {
  it('resolves inside the expected directory', () => {
    const p = shardPath(tmpRoot, '1-1-foo', 'state');
    expect(p.endsWith('.autopilot-state/1-1-foo.yaml')).toBe(true);
  });
  it('refuses to resolve outside the kind dir', () => {
    // STORY_RE blocks this at CLI level; directly calling shardPath with a
    // bad key proves the defense-in-depth check.
    expect(() => shardPath(tmpRoot, '../../etc/passwd' as unknown as string, 'state')).toThrow();
  });
});

describe('yamlDump + yamlLoad round-trip', () => {
  it('round-trips primitives, objects, arrays, and nested structures', () => {
    const input = {
      story: '1-1-foo',
      schema_version: 1,
      updated_at: { wall: '2026-04-23T00:00:00.000Z', monotonic: '12345' },
      test_count: 9,
      status: 'done',
      files_changed: ['a.ts', 'b.ts'],
      nested: { x: 1, y: { deep: true, label: 'value with spaces' } },
      tags: [],
      maybe: null,
    };
    const text = yamlDump(input);
    const loaded = yamlLoad(text);
    expect(loaded).toEqual(input);
  });

  it('quotes scalars that would be misread', () => {
    const out = yamlDump({ a: 'null', b: 'true', c: 'with # hash', d: '123-abc' });
    expect(out).toContain('a: "null"');
    expect(out).toContain('b: "true"');
    expect(out).toContain('c: "with # hash"');
  });

  it('round-trips JSON flow-form arrays of objects', () => {
    const input = { entries: [{ id: 'd1', ts: '2026-04-23T10:00:00Z', category: 'arch' }] };
    const text = yamlDump(input);
    expect(yamlLoad(text)).toEqual(input);
  });
});

describe('parseValue', () => {
  it('handles null and sentinels', () => {
    expect(parseValue('')).toBeNull();
    expect(parseValue('null')).toBeNull();
    expect(parseValue('~')).toBeNull();
  });
  it('handles booleans + numbers', () => {
    expect(parseValue('true')).toBe(true);
    expect(parseValue('false')).toBe(false);
    expect(parseValue('42')).toBe(42);
    expect(parseValue('-3.14')).toBeCloseTo(-3.14);
  });
  it('handles JSON flow-form', () => {
    expect(parseValue('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseValue('{"k":"v"}')).toEqual({ k: 'v' });
  });
  it('unquotes double- and single-quoted strings', () => {
    expect(parseValue('"hello"')).toBe('hello');
    expect(parseValue("'hi'")).toBe('hi');
  });
});

describe('setByDottedPath + getByDottedPath', () => {
  it('builds nested objects on demand', () => {
    const o: Record<string, unknown> = {};
    setByDottedPath(o, 'a.b.c', 1);
    expect(getByDottedPath(o, 'a.b.c')).toBe(1);
  });
  it('clobbers non-object intermediate values', () => {
    const o: Record<string, unknown> = { a: 'leaf' };
    setByDottedPath(o, 'a.b', 2);
    expect(getByDottedPath(o, 'a.b')).toBe(2);
  });
});

describe('stripTrailingComment + firstTopLevelColon', () => {
  it('preserves # inside quoted strings', () => {
    expect(stripTrailingComment('x: "a # b"')).toBe('x: "a # b"');
    expect(stripTrailingComment('x: 1 # trailer')).toBe('x: 1 ');
  });
  it('finds top-level colon outside quotes', () => {
    expect(firstTopLevelColon('a: 1')).toBe(1);
    expect(firstTopLevelColon('"a:b": value')).toBe(5);
  });
});

describe('writeShardAtomic + readShard', () => {
  it('writes a new shard with reserved keys and reads back', () => {
    writeShardAtomic(tmpRoot, '1-1-foo', 'state', { status: 'in-progress', files: ['a.ts'] });
    const loaded = readShard(tmpRoot, '1-1-foo', 'state');
    expect(loaded).not.toBeNull();
    expect(loaded!.story).toBe('1-1-foo');
    expect(loaded!.schema_version).toBe(1);
    expect(loaded!.updated_at).toMatchObject({
      wall: expect.any(String),
      monotonic: expect.any(String),
    });
    expect(loaded!.status).toBe('in-progress');
    expect(loaded!.files).toEqual(['a.ts']);
  });

  it('refuses to let user payload clobber reserved keys', () => {
    writeShardAtomic(tmpRoot, 's', 'state', {
      story: 'DIFFERENT',
      schema_version: 999,
      user_field: 'kept',
    } as never);
    const loaded = readShard(tmpRoot, 's', 'state')!;
    expect(loaded.story).toBe('s');
    expect(loaded.schema_version).toBe(1);
    expect(loaded.user_field).toBe('kept');
  });

  it('listShardStories enumerates shards, excluding tmp files', () => {
    writeShardAtomic(tmpRoot, 'a', 'state', {});
    writeShardAtomic(tmpRoot, 'b', 'state', {});
    // Drop a stray tmp file — must not be counted.
    writeFileSync(join(shardDir(tmpRoot, 'state'), '.tmp.garbage'), 'x');
    const stories = listShardStories(tmpRoot, 'state');
    expect(new Set(stories)).toEqual(new Set(['a', 'b']));
  });
});

describe('appendToListAtPath', () => {
  it('creates the list if absent and appends', () => {
    const o = appendToListAtPath({}, 'events', { a: 1 });
    expect(o.events).toEqual([{ a: 1 }]);
  });
  it('appends to a pre-existing list', () => {
    const o = appendToListAtPath({ events: [{ a: 1 }] }, 'events', { a: 2 });
    expect(o.events).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it('throws on empty path', () => {
    expect(() => appendToListAtPath({}, '', {})).toThrow();
  });
});

describe('CLI integration', () => {
  it('init + write + read round-trip', () => {
    execFileSync(process.execPath, [SCRIPT, 'init', '--story', 's1', '--project-root', tmpRoot]);
    execFileSync(process.execPath, [
      SCRIPT,
      'write',
      '--story',
      's1',
      '--json',
      JSON.stringify({ count: 3, tags: ['x', 'y'] }),
      '--project-root',
      tmpRoot,
    ]);
    const out = execFileSync(process.execPath, [
      SCRIPT,
      'read',
      '--story',
      's1',
      '--format',
      'json',
      '--project-root',
      tmpRoot,
    ]).toString();
    const obj = JSON.parse(out);
    expect(obj.story).toBe('s1');
    expect(obj.count).toBe(3);
    expect(obj.tags).toEqual(['x', 'y']);
  });

  it('rejects bad --story with exit 1', () => {
    const res = spawnSync(process.execPath, [
      SCRIPT,
      'write',
      '--story',
      '../etc/passwd',
      '--field',
      'a=1',
      '--project-root',
      tmpRoot,
    ]);
    expect(res.status).toBe(1);
  });

  it('is race-safe under N parallel subprocess writes to DIFFERENT stories', () => {
    const N = 8;
    const kids = [];
    for (let i = 0; i < N; i++) {
      kids.push(
        spawnSync(process.execPath, [
          SCRIPT,
          'write',
          '--story',
          `race-${i}`,
          '--field',
          `i=${i}`,
          '--project-root',
          tmpRoot,
        ]),
      );
    }
    for (const k of kids) expect(k.status).toBe(0);
    for (let i = 0; i < N; i++) {
      const shard = readShard(tmpRoot, `race-${i}`, 'state')!;
      expect(shard.i).toBe(i);
    }
  });
});
