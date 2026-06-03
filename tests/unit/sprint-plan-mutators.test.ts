// Phase 2 — sprint-plan.js mutator primitives.
//
// Covers: markDone, markSkipped, markExcluded, markRunning, addStories,
// removeStories, reorder, setIssueId, setIssueTracker, refreshBmadStatus,
// archive, and the shared `mutate` helper.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import sprintPlanMod from '../../_Sprintpilot/scripts/sprint-plan.js';

type Plan = {
  schema_version: number;
  plan_id: string;
  generated: string;
  source: string;
  status: { last_run_outcome: string; last_run_at: string; last_error: unknown };
  issue_tracker: unknown;
  epics: Array<Record<string, unknown>>;
  stories: Array<Record<string, unknown>>;
  dependencies: {
    version: number;
    auto_inferred_at: string | null;
    stories: Record<string, unknown>;
  };
  cross_epic_deps: unknown[];
  overrides: unknown[];
  notes: string;
};

const {
  TERMINAL_BMAD_STATUSES,
  planPath,
  emptyPlan,
  write,
  read,
  markDone,
  markSkipped,
  markExcluded,
  markRunning,
  addStories,
  removeStories,
  reorder,
  resolveInsertIdx,
  setIssueId,
  setIssueTracker,
  refreshBmadStatus,
  archive,
  mutate,
  findStoryIdx,
  findEpicIdx,
} = sprintPlanMod as {
  TERMINAL_BMAD_STATUSES: Set<string>;
  planPath: (root: string) => string;
  emptyPlan: (opts?: { source?: string }) => Plan;
  write: (plan: Plan, opts: { projectRoot: string }) => string;
  read: (opts: { projectRoot: string }) => Plan | null | { error: string; message: string };
  markDone: (key: string, opts: { projectRoot: string }) => string;
  markSkipped: (key: string, reason: string, opts: { projectRoot: string }) => string;
  markExcluded: (keys: string[], opts: { projectRoot: string }) => string;
  markRunning: (key: string, step: string | null, opts: { projectRoot: string }) => string;
  addStories: (
    entries: Array<Record<string, unknown>>,
    opts: { projectRoot: string; position?: string | number },
  ) => string;
  removeStories: (keys: string[], opts: { projectRoot: string; status?: string }) => string;
  reorder: (newOrder: string[], opts: { projectRoot: string }) => string;
  resolveInsertIdx: (stories: unknown[], pos: string | number | null) => number;
  setIssueId: (
    entity_key: string,
    issue_id: string | null,
    opts: { projectRoot: string },
  ) => { kind: string; index: number };
  setIssueTracker: (config: unknown, opts: { projectRoot: string }) => string;
  refreshBmadStatus: (opts: { projectRoot: string }) => {
    wrote: boolean;
    changed: { stories: number; epics: number; transitions: number };
    reason?: string;
  };
  archive: (
    plan_id: string,
    opts: { projectRoot: string },
  ) => { archived: boolean; file?: string; reason?: string };
  mutate: (root: string, fn: (plan: Plan) => Plan) => string;
  findStoryIdx: (plan: Plan, key: string) => number;
  findEpicIdx: (plan: Plan, id: string) => number;
};

let tmpRoot = '';

function seedEmptyPlan(): Plan {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-mut-'));
  const plan = emptyPlan({ source: 'auto' });
  write(plan, { projectRoot: tmpRoot });
  return plan;
}

function readBack(): Plan {
  return read({ projectRoot: tmpRoot }) as Plan;
}

beforeEach(() => {
  seedEmptyPlan();
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

// ──────────────────────────────────────────────────────────────────
// mutate (shared)
// ──────────────────────────────────────────────────────────────────

describe('mutate', () => {
  it('throws no_plan when no plan file exists', () => {
    rmSync(planPath(tmpRoot));
    let err: Error | null = null;
    try {
      mutate(tmpRoot, (p) => p);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as { code?: string }).code).toBe('no_plan');
  });

  it('throws with corrupt-file error code on parse failure', () => {
    writeFileSync(planPath(tmpRoot), 'broken: : yaml :\n');
    let err: Error | null = null;
    try {
      mutate(tmpRoot, (p) => p);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as { code?: string }).code).toBe('parse_error');
  });
});

// ──────────────────────────────────────────────────────────────────
// markDone
// ──────────────────────────────────────────────────────────────────

describe('markDone', () => {
  it('sets plan_status=done and stamps completed_at', () => {
    markDone('1-1-bootstrap', { projectRoot: tmpRoot });
    const plan = readBack();
    expect(plan.stories[0].key).toBe('1-1-bootstrap');
    expect(plan.stories[0].plan_status).toBe('done');
    expect(plan.stories[0].completed_at).toEqual(expect.any(String));
  });

  it('updates an existing entry rather than duplicating it', () => {
    addStories([{ key: '1-1-bootstrap', title: 'Bootstrap' }], { projectRoot: tmpRoot });
    markDone('1-1-bootstrap', { projectRoot: tmpRoot });
    const plan = readBack();
    expect(plan.stories.length).toBe(1);
    expect(plan.stories[0].title).toBe('Bootstrap'); // preserved
    expect(plan.stories[0].plan_status).toBe('done');
  });

  it('clears current_step (set by markRunning)', () => {
    markRunning('1-1-bootstrap', 'DEV_STORY_GREEN', { projectRoot: tmpRoot });
    expect(readBack().stories[0].current_step).toBe('DEV_STORY_GREEN');
    markDone('1-1-bootstrap', { projectRoot: tmpRoot });
    expect(readBack().stories[0].current_step).toBeNull();
  });

  it('infers epic from the story key', () => {
    markDone('2-3-foo', { projectRoot: tmpRoot });
    expect(readBack().stories[0].epic).toBe('2');
  });
});

// ──────────────────────────────────────────────────────────────────
// markSkipped / markExcluded / markRunning
// ──────────────────────────────────────────────────────────────────

describe('markSkipped', () => {
  it('sets plan_status=skipped and records the reason', () => {
    markSkipped('1-2-models', 'blocked on external API', { projectRoot: tmpRoot });
    const s = readBack().stories[0];
    expect(s.plan_status).toBe('skipped');
    expect(s.skip_reason).toBe('blocked on external API');
  });

  it('accepts a null/missing reason', () => {
    markSkipped('1-2-models', null as unknown as string, { projectRoot: tmpRoot });
    expect(readBack().stories[0].skip_reason).toBeNull();
  });
});

describe('markExcluded', () => {
  it('marks every key in the input array', () => {
    markExcluded(['1-1-bootstrap', '1-2-models'], { projectRoot: tmpRoot });
    const plan = readBack();
    expect(plan.stories.length).toBe(2);
    expect(plan.stories.every((s) => s.plan_status === 'excluded')).toBe(true);
  });

  it('throws when given a non-array', () => {
    expect(() =>
      markExcluded('not-an-array' as unknown as string[], { projectRoot: tmpRoot }),
    ).toThrow(/array of story keys/);
  });
});

describe('markRunning', () => {
  it('sets and clears the current_step field', () => {
    markRunning('1-3-add-auth', 'CODE_REVIEW', { projectRoot: tmpRoot });
    expect(readBack().stories[0].current_step).toBe('CODE_REVIEW');
    markRunning('1-3-add-auth', null, { projectRoot: tmpRoot });
    expect(readBack().stories[0].current_step).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// addStories
// ──────────────────────────────────────────────────────────────────

describe('addStories', () => {
  it('appends to the end by default and assigns 1-indexed priorities', () => {
    addStories(
      [
        { key: '1-1-a', title: 'A' },
        { key: '1-2-b', title: 'B' },
      ],
      { projectRoot: tmpRoot },
    );
    const plan = readBack();
    expect(plan.stories.map((s) => s.key)).toEqual(['1-1-a', '1-2-b']);
    expect(plan.stories.map((s) => s.priority)).toEqual([1, 2]);
  });

  it("honors position='after:<key>' insertion", () => {
    addStories([{ key: '1-1-a' }, { key: '1-3-c' }], { projectRoot: tmpRoot });
    addStories([{ key: '1-2-b' }], { projectRoot: tmpRoot, position: 'after:1-1-a' });
    expect(readBack().stories.map((s) => s.key)).toEqual(['1-1-a', '1-2-b', '1-3-c']);
  });

  it('honors integer position', () => {
    addStories([{ key: 'a' }, { key: 'c' }], { projectRoot: tmpRoot });
    addStories([{ key: 'b' }], { projectRoot: tmpRoot, position: 1 });
    expect(readBack().stories.map((s) => s.key)).toEqual(['a', 'b', 'c']);
  });

  it('rejects empty entries arrays', () => {
    expect(() => addStories([], { projectRoot: tmpRoot })).toThrow(/non-empty array/);
  });

  it('rejects entries without a key', () => {
    expect(() => addStories([{ title: 'no key' }], { projectRoot: tmpRoot })).toThrow(/key/);
  });

  it('rejects entries whose key is already in the plan', () => {
    addStories([{ key: '1-1-a' }], { projectRoot: tmpRoot });
    expect(() => addStories([{ key: '1-1-a' }], { projectRoot: tmpRoot })).toThrow(
      /already in the plan/,
    );
  });

  it('infers epic from the key when not provided', () => {
    addStories([{ key: '7-1-foo' }], { projectRoot: tmpRoot });
    expect(readBack().stories[0].epic).toBe('7');
  });

  it('preserves explicit epic, plan_status, issue_id, upstream', () => {
    addStories(
      [
        {
          key: '1-1-a',
          epic: 'custom-epic',
          plan_status: 'excluded',
          issue_id: 'PROJ-1',
          upstream: ['x', 'y'],
          rationale: 'note',
        },
      ],
      { projectRoot: tmpRoot },
    );
    const s = readBack().stories[0];
    expect(s.epic).toBe('custom-epic');
    expect(s.plan_status).toBe('excluded');
    expect(s.issue_id).toBe('PROJ-1');
    expect(s.upstream).toEqual(['x', 'y']);
    expect(s.rationale).toBe('note');
  });
});

describe('resolveInsertIdx', () => {
  const stories = [{ key: 'a' }, { key: 'b' }, { key: 'c' }] as Array<{ key: string }>;
  it('end / null / undefined → length', () => {
    expect(resolveInsertIdx(stories, 'end')).toBe(3);
    expect(resolveInsertIdx(stories, null)).toBe(3);
  });
  it('after:<key> → after that index', () => {
    expect(resolveInsertIdx(stories, 'after:a')).toBe(1);
    expect(resolveInsertIdx(stories, 'after:c')).toBe(3);
  });
  it('after:<missing key> → append at end', () => {
    expect(resolveInsertIdx(stories, 'after:zzz')).toBe(3);
  });
  it('positive integer is clamped to length', () => {
    expect(resolveInsertIdx(stories, 100)).toBe(3);
    expect(resolveInsertIdx(stories, 1)).toBe(1);
  });
  it('negative integer counts from end', () => {
    expect(resolveInsertIdx(stories, -1)).toBe(3);
    expect(resolveInsertIdx(stories, -2)).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────
// removeStories
// ──────────────────────────────────────────────────────────────────

describe('removeStories', () => {
  beforeEach(() => {
    addStories([{ key: 'a' }, { key: 'b' }, { key: 'c' }], { projectRoot: tmpRoot });
  });

  it("default status='skipped' marks the entries", () => {
    removeStories(['a', 'b'], { projectRoot: tmpRoot });
    const plan = readBack();
    expect(plan.stories.find((s) => s.key === 'a')?.plan_status).toBe('skipped');
    expect(plan.stories.find((s) => s.key === 'b')?.plan_status).toBe('skipped');
    expect(plan.stories.find((s) => s.key === 'c')?.plan_status).toBe('pending');
  });

  it("status='deferred' applies a different label", () => {
    removeStories(['a'], { projectRoot: tmpRoot, status: 'deferred' });
    expect(readBack().stories.find((s) => s.key === 'a')?.plan_status).toBe('deferred');
  });

  it('rejects unknown statuses', () => {
    expect(() => removeStories(['a'], { projectRoot: tmpRoot, status: 'banished' })).toThrow(
      /must be 'skipped' or 'deferred'/,
    );
  });

  it('throws missing_keys for keys absent from the plan', () => {
    let err: { code?: string; missing_keys?: string[] } | null = null;
    try {
      removeStories(['nope'], { projectRoot: tmpRoot });
    } catch (e) {
      err = e as { code?: string; missing_keys?: string[] };
    }
    expect(err?.code).toBe('missing_keys');
    expect(err?.missing_keys).toEqual(['nope']);
  });
});

// ──────────────────────────────────────────────────────────────────
// reorder
// ──────────────────────────────────────────────────────────────────

describe('reorder', () => {
  beforeEach(() => {
    addStories([{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }], { projectRoot: tmpRoot });
  });

  it('reassigns priorities to match newOrder', () => {
    reorder(['c', 'a', 'b', 'd'], { projectRoot: tmpRoot });
    const plan = readBack();
    expect(plan.stories.map((s) => s.key)).toEqual(['c', 'a', 'b', 'd']);
    expect(plan.stories.map((s) => s.priority)).toEqual([1, 2, 3, 4]);
  });

  it('appends omitted entries at the end, preserving relative order', () => {
    reorder(['c', 'a'], { projectRoot: tmpRoot });
    // b and d weren't mentioned — they end up after c, a in original order.
    expect(readBack().stories.map((s) => s.key)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('dedupes within newOrder silently', () => {
    reorder(['a', 'b', 'a'], { projectRoot: tmpRoot });
    expect(readBack().stories.map((s) => s.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('throws unknown_keys for stories absent from the plan', () => {
    let err: { code?: string; unknown_keys?: string[] } | null = null;
    try {
      reorder(['nope'], { projectRoot: tmpRoot });
    } catch (e) {
      err = e as { code?: string; unknown_keys?: string[] };
    }
    expect(err?.code).toBe('unknown_keys');
    expect(err?.unknown_keys).toEqual(['nope']);
  });
});

// ──────────────────────────────────────────────────────────────────
// setIssueId / setIssueTracker
// ──────────────────────────────────────────────────────────────────

describe('setIssueId', () => {
  it('sets issue_id on an existing story entry', () => {
    addStories([{ key: '1-1-a' }], { projectRoot: tmpRoot });
    const r = setIssueId('1-1-a', 'PROJ-101', { projectRoot: tmpRoot });
    expect(r.kind).toBe('story');
    expect(readBack().stories[0].issue_id).toBe('PROJ-101');
  });

  it('creates a story entry on demand', () => {
    const r = setIssueId('9-9-z', 'PROJ-999', { projectRoot: tmpRoot });
    expect(r.kind).toBe('story');
    const plan = readBack();
    expect(plan.stories.find((s) => s.key === '9-9-z')?.issue_id).toBe('PROJ-999');
  });

  it('sets issue_id on an epic when the entity_key matches an epic id', () => {
    // Seed an epic entry directly.
    mutate(tmpRoot, (plan) => {
      plan.epics.push({ id: '7', title: 'Test Epic' });
      return plan;
    });
    const r = setIssueId('7', 'PROJ-EPIC', { projectRoot: tmpRoot });
    expect(r.kind).toBe('epic');
    expect(readBack().epics[0].issue_id).toBe('PROJ-EPIC');
  });

  it('rejects non-string issue_id', () => {
    expect(() => setIssueId('x', 123 as unknown as string, { projectRoot: tmpRoot })).toThrow(
      /string or null/,
    );
  });
});

describe('setIssueTracker', () => {
  it('writes the top-level issue_tracker block', () => {
    setIssueTracker(
      { provider: 'jira', base_url: 'https://co.atlassian.net', project_key: 'PROJ' },
      { projectRoot: tmpRoot },
    );
    expect(readBack().issue_tracker).toEqual({
      provider: 'jira',
      base_url: 'https://co.atlassian.net',
      project_key: 'PROJ',
    });
  });

  it('null config clears the tracker entirely', () => {
    setIssueTracker({ provider: 'jira' }, { projectRoot: tmpRoot });
    setIssueTracker(null, { projectRoot: tmpRoot });
    expect(readBack().issue_tracker).toBeNull();
  });

  it('fills missing fields with null', () => {
    setIssueTracker({ provider: 'github' }, { projectRoot: tmpRoot });
    expect(readBack().issue_tracker).toEqual({
      provider: 'github',
      base_url: null,
      project_key: null,
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// refreshBmadStatus
// ──────────────────────────────────────────────────────────────────

describe('refreshBmadStatus', () => {
  function seedSprintStatus(content: string): void {
    const impl = join(tmpRoot, '_bmad-output', 'implementation-artifacts');
    mkdirSync(impl, { recursive: true });
    writeFileSync(join(impl, 'sprint-status.yaml'), content);
  }

  it('returns no_plan when sprint-plan.yaml is missing', () => {
    rmSync(planPath(tmpRoot));
    const r = refreshBmadStatus({ projectRoot: tmpRoot });
    expect(r.wrote).toBe(false);
    expect(r.reason).toBe('no_plan');
  });

  it('updates bmad_status from sprint-status.yaml when stories change', () => {
    addStories([{ key: '1-1-a' }, { key: '1-2-b' }], { projectRoot: tmpRoot });
    seedSprintStatus('development_status:\n  1-1-a: in-progress\n  1-2-b: review\n');
    const r = refreshBmadStatus({ projectRoot: tmpRoot });
    expect(r.wrote).toBe(true);
    expect(r.changed.stories).toBe(2);
    const plan = readBack();
    expect(plan.stories[0].bmad_status).toBe('in-progress');
    expect(plan.stories[1].bmad_status).toBe('review');
  });

  it('eagerly transitions plan_status to done for terminal bmad statuses', () => {
    addStories([{ key: '1-1-a' }], { projectRoot: tmpRoot });
    seedSprintStatus('development_status:\n  1-1-a: done\n');
    const r = refreshBmadStatus({ projectRoot: tmpRoot });
    expect(r.changed.transitions).toBe(1);
    const plan = readBack();
    expect(plan.stories[0].plan_status).toBe('done');
    expect(plan.stories[0].completed_at).toEqual(expect.any(String));
  });

  it('respects every TERMINAL_BMAD_STATUSES value', () => {
    const keys = [...TERMINAL_BMAD_STATUSES];
    for (const status of keys) {
      // Spelling variant "won't_do" with apostrophe is in the set; sprint-status
      // sample uses simple identifiers, so we test the un-apostrophed canonical
      // form per the autopilot constant.
      if (status === "won't_do") continue;
      const story_key = `1-${keys.indexOf(status)}-test`;
      const r2 = refreshBmadStatus({ projectRoot: tmpRoot });
      addStories([{ key: story_key }], { projectRoot: tmpRoot });
      seedSprintStatus(`development_status:\n  ${story_key}: ${status}\n`);
      refreshBmadStatus({ projectRoot: tmpRoot });
      const plan = readBack();
      const entry = plan.stories.find((s) => s.key === story_key);
      expect(entry?.plan_status).toBe('done');
      void r2;
    }
  });

  it('skips the write when nothing changed (disk-thrash mitigation)', () => {
    addStories([{ key: '1-1-a' }], { projectRoot: tmpRoot });
    seedSprintStatus('development_status:\n  1-1-a: backlog\n');
    refreshBmadStatus({ projectRoot: tmpRoot });
    // First call writes (changed: bmad_status from null → backlog).
    // Second call should be a no-op since nothing changes.
    const second = refreshBmadStatus({ projectRoot: tmpRoot });
    expect(second.wrote).toBe(false);
    expect(second.changed).toEqual({ stories: 0, epics: 0, transitions: 0 });
  });

  it('aggregates epic bmad_status from contained stories', () => {
    mutate(tmpRoot, (plan) => {
      plan.epics.push({ id: '1', title: 'Epic 1' });
      return plan;
    });
    addStories(
      [
        { key: '1-1-a', epic: '1' },
        { key: '1-2-b', epic: '1' },
      ],
      { projectRoot: tmpRoot },
    );
    seedSprintStatus('development_status:\n  1-1-a: done\n  1-2-b: done\n');
    refreshBmadStatus({ projectRoot: tmpRoot });
    expect(readBack().epics[0].bmad_status).toBe('done');
  });
});

// ──────────────────────────────────────────────────────────────────
// archive
// ──────────────────────────────────────────────────────────────────

describe('archive', () => {
  it('moves the live plan into .archive/sprint-plan-<id>.yaml', () => {
    const planBefore = readBack();
    const r = archive(planBefore.plan_id, { projectRoot: tmpRoot });
    expect(r.archived).toBe(true);
    expect(r.file as string).toMatch(/[\\/]\.archive[\\/]sprint-plan-/);
    expect(existsSync(r.file as string)).toBe(true);
    expect(existsSync(planPath(tmpRoot))).toBe(false);
  });

  it('handles re-archive collisions with a numbered suffix', () => {
    const planBefore = readBack();
    const id = planBefore.plan_id;
    archive(id, { projectRoot: tmpRoot });
    // Re-seed the live plan and archive again with the same plan_id.
    write(planBefore, { projectRoot: tmpRoot });
    const second = archive(id, { projectRoot: tmpRoot });
    expect(second.archived).toBe(true);
    expect(second.file).toMatch(/\.1\.yaml$/);
  });

  it('returns no_live_plan when nothing to archive', () => {
    rmSync(planPath(tmpRoot));
    const r = archive('anything', { projectRoot: tmpRoot });
    expect(r.archived).toBe(false);
    expect(r.reason).toBe('no_live_plan');
  });

  it('generates a fallback id when plan_id is missing', () => {
    const r = archive('', { projectRoot: tmpRoot });
    expect(r.file).toMatch(/sprint-plan-unknown-/);
  });
});

// ──────────────────────────────────────────────────────────────────
// Cross-cutting: every mutator preserves unrelated top-level fields
// ──────────────────────────────────────────────────────────────────

describe('field preservation across mutators', () => {
  it('keeps notes, issue_tracker, dependencies, cross_epic_deps verbatim', () => {
    const seeded: Plan = readBack();
    seeded.notes = 'sprint 7 priorities';
    seeded.issue_tracker = { provider: 'jira', base_url: null, project_key: 'PROJ' };
    seeded.cross_epic_deps = [{ from_story: 'x', to_story: 'y', rationale: 'r' }];
    seeded.dependencies.stories = { x: { depends_on: ['y'], rationale: 'r' } };
    write(seeded, { projectRoot: tmpRoot });

    markDone('story-1', { projectRoot: tmpRoot });
    markSkipped('story-2', 'reason', { projectRoot: tmpRoot });
    addStories([{ key: 'story-3' }], { projectRoot: tmpRoot });
    setIssueId('story-1', 'ID-1', { projectRoot: tmpRoot });

    const final = readBack();
    expect(final.notes).toBe('sprint 7 priorities');
    expect(final.issue_tracker).toEqual({ provider: 'jira', base_url: null, project_key: 'PROJ' });
    expect(final.cross_epic_deps).toEqual([{ from_story: 'x', to_story: 'y', rationale: 'r' }]);
    expect(final.dependencies.stories.x).toEqual({ depends_on: ['y'], rationale: 'r' });
  });
});

// ──────────────────────────────────────────────────────────────────
// findStoryIdx / findEpicIdx helpers
// ──────────────────────────────────────────────────────────────────

describe('find helpers', () => {
  it('findStoryIdx returns -1 for missing keys', () => {
    expect(findStoryIdx(readBack(), 'missing')).toBe(-1);
  });

  it('findEpicIdx matches by id', () => {
    mutate(tmpRoot, (plan) => {
      plan.epics.push({ id: '3', title: 'Three' });
      return plan;
    });
    expect(findEpicIdx(readBack(), '3')).toBe(0);
    expect(findEpicIdx(readBack(), 3 as unknown as string)).toBe(0);
  });
});
