import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import mergeMod from '../../_Sprintpilot/scripts/merge-shards.js';
// @ts-expect-error — CommonJS module
import shardMod from '../../_Sprintpilot/scripts/state-shard.js';

const { merge, isValidShard, compareStamps } = mergeMod as {
  merge: (
    root: string,
    opts?: { layerId?: string; archive?: boolean; dryRun?: boolean },
  ) => {
    state: { stories: number; problems: number };
    decisions: { entries: number; problems: number };
    files: { state: string; decisions: string };
    archived_corrupt: Array<{ kind: string; story: string }>;
    archive_dir: string | null;
    dry_run: boolean;
  };
  isValidShard: (x: unknown) => boolean;
  compareStamps: (
    a: { wall?: string; monotonic?: string } | null | undefined,
    b: { wall?: string; monotonic?: string } | null | undefined,
  ) => number;
};

const { writeShardAtomic, yamlLoad, shardPath } = shardMod as {
  writeShardAtomic: (root: string, story: string, kind: string, obj: Record<string, unknown>) => string;
  yamlLoad: (s: string) => Record<string, unknown>;
  shardPath: (root: string, story: string, kind: string) => string;
};

const REPO_ROOT = join(__dirname, '..', '..');
const MERGE_SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'merge-shards.js');

let tmpRoot = '';
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-merge-'));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('isValidShard', () => {
  it('requires updated_at.wall at minimum', () => {
    expect(isValidShard(null)).toBe(false);
    expect(isValidShard({})).toBe(false);
    expect(isValidShard({ updated_at: 'scalar' })).toBe(false);
    expect(isValidShard({ updated_at: { monotonic: '1' } })).toBe(false);
    expect(isValidShard({ updated_at: { wall: '2026-04-23T00:00:00.000Z' } })).toBe(true);
  });
});

describe('compareStamps', () => {
  it('prefers monotonic when both present', () => {
    const a = { wall: '2026-04-23T00:00:00.000Z', monotonic: '10' };
    const b = { wall: '2026-04-23T00:00:00.000Z', monotonic: '20' };
    expect(compareStamps(a, b)).toBe(-1);
    expect(compareStamps(b, a)).toBe(1);
    expect(compareStamps(a, a)).toBe(0);
  });
  it('falls back to wall-clock when one side has no monotonic', () => {
    const a = { wall: '2026-04-23T00:00:00.000Z' };
    const b = { wall: '2026-04-23T00:00:01.000Z', monotonic: '99' };
    expect(compareStamps(a, b)).toBe(-1);
  });
  it('returns 0 on empty inputs', () => {
    expect(compareStamps({}, {})).toBe(0);
  });
});

describe('merge — happy paths', () => {
  it('returns empty counts when no shards exist', () => {
    const r = merge(tmpRoot);
    expect(r.state.stories).toBe(0);
    expect(r.decisions.entries).toBe(0);
    expect(readFileSync(r.files.state, 'utf8')).toContain('schema_version: 1');
  });

  it('merges state shards across multiple stories', () => {
    writeShardAtomic(tmpRoot, 'a', 'state', { status: 'done', count: 5 });
    writeShardAtomic(tmpRoot, 'b', 'state', { status: 'in-progress', count: 2 });
    const r = merge(tmpRoot);
    expect(r.state.stories).toBe(2);
    const merged = yamlLoad(readFileSync(r.files.state, 'utf8')) as {
      stories: Record<string, { status: string; count: number }>;
    };
    expect(merged.stories.a.status).toBe('done');
    expect(merged.stories.b.count).toBe(2);
  });

  it('deduplicates decision-log entries by id and sorts by ts', () => {
    writeShardAtomic(tmpRoot, 'a', 'decision-log', {
      entries: [
        { id: 'd2', ts: '2026-04-23T02:00:00Z', category: 'architecture', decision: 'B' },
        { id: 'd1', ts: '2026-04-23T01:00:00Z', category: 'architecture', decision: 'A' },
      ],
    });
    writeShardAtomic(tmpRoot, 'b', 'decision-log', {
      entries: [
        // duplicate id — should be dropped
        { id: 'd1', ts: '2026-04-23T01:00:00Z', category: 'architecture', decision: 'DUPLICATE' },
        { id: 'd3', ts: '2026-04-23T03:00:00Z', category: 'architecture', decision: 'C' },
      ],
    });
    const r = merge(tmpRoot);
    expect(r.decisions.entries).toBe(3);
    const merged = yamlLoad(readFileSync(r.files.decisions, 'utf8')) as {
      entries: Array<{ id: string; decision: string }>;
    };
    expect(merged.entries.map((e) => e.id)).toEqual(['d1', 'd2', 'd3']);
    expect(merged.entries[0].decision).toBe('A'); // not the duplicate
  });

  it('is idempotent — running twice produces identical merged files', () => {
    writeShardAtomic(tmpRoot, 'a', 'state', { status: 'done' });
    writeShardAtomic(tmpRoot, 'a', 'decision-log', {
      entries: [{ id: 'd1', ts: '2026-04-23T00:00:00Z', category: 'arch', decision: 'x' }],
    });
    const r1 = merge(tmpRoot);
    const body1a = readFileSync(r1.files.state, 'utf8').replace(/merged_at: "[^"]+"/, 'merged_at: <T>');
    const body1b = readFileSync(r1.files.decisions, 'utf8').replace(/merged_at: "[^"]+"/, 'merged_at: <T>');
    const r2 = merge(tmpRoot);
    const body2a = readFileSync(r2.files.state, 'utf8').replace(/merged_at: "[^"]+"/, 'merged_at: <T>');
    const body2b = readFileSync(r2.files.decisions, 'utf8').replace(/merged_at: "[^"]+"/, 'merged_at: <T>');
    expect(body2a).toBe(body1a);
    expect(body2b).toBe(body1b);
  });
});

describe('merge — corruption recovery', () => {
  it('archives corrupt shards and continues merging others', () => {
    writeShardAtomic(tmpRoot, 'good', 'state', { status: 'done' });
    // Inject a truly corrupt shard alongside: no updated_at at all, not even parseable shape.
    const badPath = shardPath(tmpRoot, 'bad', 'state');
    mkdirSync(join(tmpRoot, '_bmad-output/implementation-artifacts/.autopilot-state'), {
      recursive: true,
    });
    writeFileSync(badPath, 'this is :: not :: parseable: %(&\n');
    const r = merge(tmpRoot);
    // Good shard still merged; bad one flagged + archived.
    expect(r.state.stories).toBeGreaterThanOrEqual(1);
    expect(r.state.problems + r.archived_corrupt.length).toBeGreaterThan(0);
    expect(existsSync(badPath)).toBe(false); // archived, not left behind
    const archiveRoot = join(tmpRoot, '_bmad-output/implementation-artifacts/.archive/corrupt');
    const archived = readdirSync(archiveRoot);
    expect(archived.some((f) => f.includes('bad'))).toBe(true);
  });

  it('treats a shard missing updated_at as invalid', () => {
    const p = shardPath(tmpRoot, 'no-stamp', 'state');
    mkdirSync(join(tmpRoot, '_bmad-output/implementation-artifacts/.autopilot-state'), {
      recursive: true,
    });
    writeFileSync(p, 'story: no-stamp\nstatus: done\n');
    const r = merge(tmpRoot);
    expect(r.archived_corrupt.some((a) => a.story === 'no-stamp')).toBe(true);
  });
});

describe('merge — archive mode', () => {
  it('--archive moves shards to .archive/layer-<id>/', () => {
    writeShardAtomic(tmpRoot, 'a', 'state', { status: 'done' });
    const r = merge(tmpRoot, { archive: true, layerId: 'L1' });
    expect(r.archive_dir).toContain('layer-L1');
    expect(existsSync(join(r.archive_dir!, '.autopilot-state', 'a.yaml'))).toBe(true);
    // Original shard moved — shouldn't exist at source after archive.
    expect(existsSync(shardPath(tmpRoot, 'a', 'state'))).toBe(false);
  });
});

describe('merge — dry run', () => {
  it('does not write files when --dry-run is set', () => {
    writeShardAtomic(tmpRoot, 'a', 'state', { status: 'done' });
    const r = merge(tmpRoot, { dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(existsSync(r.files.state)).toBe(false);
  });
});

describe('CLI integration', () => {
  it('exits 0 on empty repo and prints JSON summary', () => {
    const out = execFileSync(process.execPath, [MERGE_SCRIPT, '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    expect(parsed.state.stories).toBe(0);
    expect(parsed.decisions.entries).toBe(0);
  });
});
