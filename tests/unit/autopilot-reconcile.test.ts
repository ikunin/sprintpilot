import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import autopilot from '../../_Sprintpilot/bin/autopilot.js';

type Persisted = {
  current_story: string | null;
  story_file_path: string | null;
  current_epic: string | null;
  current_bmad_step: string | null;
  story_queue: string[];
};

type ReconcileAction =
  | { kind: 'clear_completed_story'; story: string }
  | { kind: 'clear_unknown_story'; story: string }
  | { kind: 'prune_completed_from_queue'; removed: string[] };

type ReconcileResult =
  | { ok: true; actions: ReconcileAction[] }
  | { ok: false; reason: string; details?: string };

const { reconcileWithSprintStatus } = autopilot as {
  reconcileWithSprintStatus: (input: {
    projectRoot: string;
    persisted: Persisted;
  }) => ReconcileResult;
};

let projectRoot: string;

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'sprintpilot-reconcile-'));
}

function writeSprintStatus(root: string, body: string): void {
  const dir = join(root, '_bmad-output', 'implementation-artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sprint-status.yaml'), body, 'utf8');
}

function persisted(overrides: Partial<Persisted> = {}): Persisted {
  return {
    current_story: null,
    story_file_path: null,
    current_epic: null,
    current_bmad_step: null,
    story_queue: [],
    ...overrides,
  };
}

beforeEach(() => {
  projectRoot = makeProject();
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('reconcileWithSprintStatus', () => {
  it('reports not-ok when sprint-status.yaml is missing', () => {
    const r = reconcileWithSprintStatus({ projectRoot, persisted: persisted() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('sprint_status_missing_or_unparseable');
  });

  it('returns ok with no actions when persisted state already matches sprint-status', () => {
    writeSprintStatus(
      projectRoot,
      'development_status:\n  1-1-a: in-progress\n  1-2-b: backlog\n',
    );
    const p = persisted({ current_story: '1-1-a', current_bmad_step: 'dev_red' });
    const r = reconcileWithSprintStatus({ projectRoot, persisted: p });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actions).toEqual([]);
    // Persisted unchanged
    expect(p.current_story).toBe('1-1-a');
    expect(p.current_bmad_step).toBe('dev_red');
  });

  it('clears current_story when sprint-status marks it done (external completion)', () => {
    writeSprintStatus(
      projectRoot,
      'development_status:\n  1-1-a: done\n  1-2-b: backlog\n',
    );
    const p = persisted({
      current_story: '1-1-a',
      story_file_path: '_bmad-output/stories/1-1-a.md',
      current_epic: '1',
      current_bmad_step: 'story_land',
    });
    const r = reconcileWithSprintStatus({ projectRoot, persisted: p });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actions).toEqual([{ kind: 'clear_completed_story', story: '1-1-a' }]);
    }
    expect(p.current_story).toBeNull();
    expect(p.story_file_path).toBeNull();
    expect(p.current_epic).toBeNull();
    expect(p.current_bmad_step).toBeNull();
  });

  it('clears current_story when sprint-status no longer knows about it', () => {
    writeSprintStatus(projectRoot, 'development_status:\n  1-2-b: backlog\n');
    const p = persisted({ current_story: '1-1-vanished', current_bmad_step: 'dev_green' });
    const r = reconcileWithSprintStatus({ projectRoot, persisted: p });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actions).toEqual([{ kind: 'clear_unknown_story', story: '1-1-vanished' }]);
    }
    expect(p.current_story).toBeNull();
  });

  it('prunes completed stories from story_queue', () => {
    writeSprintStatus(
      projectRoot,
      'development_status:\n  1-1-a: done\n  1-2-b: backlog\n  1-3-c: done\n  1-4-d: backlog\n',
    );
    const p = persisted({
      current_story: '1-2-b',
      story_queue: ['1-1-a', '1-2-b', '1-3-c', '1-4-d'],
    });
    const r = reconcileWithSprintStatus({ projectRoot, persisted: p });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const prune = r.actions.find((a) => a.kind === 'prune_completed_from_queue');
      expect(prune).toBeDefined();
      if (prune && prune.kind === 'prune_completed_from_queue') {
        expect(prune.removed.sort()).toEqual(['1-1-a', '1-3-c']);
      }
    }
    expect(p.story_queue).toEqual(['1-2-b', '1-4-d']);
    // current_story is in-progress, sprint-status says backlog → not changed
    // (reconcile only clears done / unknown; non-done statuses pass through).
    expect(p.current_story).toBe('1-2-b');
  });

  it('handles both current_story completion AND queue pruning in one pass', () => {
    writeSprintStatus(
      projectRoot,
      'development_status:\n  1-1-a: done\n  1-2-b: done\n  1-3-c: backlog\n',
    );
    const p = persisted({
      current_story: '1-1-a',
      story_file_path: '_bmad-output/stories/1-1-a.md',
      current_epic: '1',
      current_bmad_step: 'story_done',
      story_queue: ['1-1-a', '1-2-b', '1-3-c'],
    });
    const r = reconcileWithSprintStatus({ projectRoot, persisted: p });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const kinds = r.actions.map((a) => a.kind).sort();
      expect(kinds).toEqual(['clear_completed_story', 'prune_completed_from_queue']);
    }
    expect(p.current_story).toBeNull();
    expect(p.story_queue).toEqual(['1-3-c']);
  });

  it('treats statuses other than "done" as still-in-flight (no clearing)', () => {
    writeSprintStatus(
      projectRoot,
      'development_status:\n  1-1-a: in-progress\n  1-2-b: ready-for-dev\n  1-3-c: review\n',
    );
    const p = persisted({ current_story: '1-1-a', current_bmad_step: 'dev_red' });
    const r = reconcileWithSprintStatus({ projectRoot, persisted: p });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actions).toEqual([]);
    expect(p.current_story).toBe('1-1-a');
  });

  it('rejects gracefully when persisted is not a plain object', () => {
    writeSprintStatus(projectRoot, 'development_status:\n  1-1-a: done\n');
    // @ts-expect-error — deliberately bad input
    const r = reconcileWithSprintStatus({ projectRoot, persisted: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_persisted_state');
  });

  it('handles uppercase / mixed-case status values (case-insensitive)', () => {
    writeSprintStatus(
      projectRoot,
      'development_status:\n  1-1-a: DONE\n  1-2-b: Done\n',
    );
    const p = persisted({
      current_story: '1-1-a',
      story_queue: ['1-1-a', '1-2-b'],
    });
    const r = reconcileWithSprintStatus({ projectRoot, persisted: p });
    expect(r.ok).toBe(true);
    expect(p.current_story).toBeNull();
    expect(p.story_queue).toEqual([]);
  });
});
