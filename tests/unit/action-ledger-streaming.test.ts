// Phase 4.5 — streaming progress.
//
// Covers:
//   - VALID_KINDS regression guard: every v2.3.0 kind we append from
//     production code paths must be in the allowlist.
//   - tail() iterator yields appended events in order, terminates on
//     maxIdleMs, handles afterSeq filtering, respects AbortSignal.
//   - readSince() filter behavior.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import ledgerMod from '../../_Sprintpilot/lib/orchestrator/action-ledger.js';
// @ts-expect-error — CommonJS module
import sprintPlanMod from '../../_Sprintpilot/scripts/sprint-plan.js';

type LedgerEntry = { seq: number; ts: string; kind: string; [k: string]: unknown };

const { VALID_KINDS, append, read, readSince, tail } = ledgerMod as {
  VALID_KINDS: string[];
  append: (entry: Record<string, unknown>, ctx: { projectRoot: string }) => LedgerEntry;
  read: (
    ctx: { projectRoot: string },
    opts?: { limit?: number },
  ) => LedgerEntry[];
  readSince: (ctx: { projectRoot: string }, afterSeq: number) => LedgerEntry[];
  tail: (
    ctx: { projectRoot: string },
    opts?: {
      afterSeq?: number;
      pollIntervalMs?: number;
      maxIdleMs?: number;
      signal?: AbortSignal;
    },
  ) => AsyncIterable<LedgerEntry>;
};

const { write: writePlan, emptyPlan, planPath } = sprintPlanMod as {
  write: (plan: Record<string, unknown>, ctx: { projectRoot: string }) => string;
  emptyPlan: (opts?: { source?: string }) => Record<string, unknown>;
  planPath: (root: string) => string;
};

const REPO_ROOT = join(__dirname, '..', '..');
const AUTOPILOT = join(REPO_ROOT, '_Sprintpilot', 'bin', 'autopilot.js');

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-stream-'));
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

// ──────────────────────────────────────────────────────────────────
// VALID_KINDS regression guard
// ──────────────────────────────────────────────────────────────────

describe('VALID_KINDS — v2.3.0 additions registered', () => {
  const REQUIRED_KINDS = [
    // Phase 3
    'plan_migrated',
    'plan_migration_failed',
    'plan_refreshed',
    'plan_refresh_failed',
    'plan_queue_loaded',
    'plan_queue_failed',
    'plan_exhausted',
    'plan_archive_failed',
    'auto_derive_emitted',
    // Phase 4
    'plan_story_done',
    'plan_story_done_failed',
    'replan_requested_consumed',
    // Phase 5
    'plan_reordered',
    'plan_reorder_rejected',
    'plan_reorder_failed',
    'plan_stories_added',
    'plan_add_stories_failed',
    'plan_stories_removed',
    'plan_remove_stories_failed',
    // Skill outcomes
    'plan_built',
    'cross_epic_edge_rejected',
    'issue_id_set',
    'dag_rendered',
    // Phase 4.5
    'story_step_started',
    'story_step_progress',
    'story_step_completed',
  ];

  it.each(REQUIRED_KINDS)('VALID_KINDS contains %s', (kind) => {
    expect(VALID_KINDS).toContain(kind);
  });

  it('append() accepts every v2.3.0 kind without throwing', () => {
    for (const kind of REQUIRED_KINDS) {
      expect(() =>
        append({ kind, detail: { test: true } }, { projectRoot: tmpRoot }),
      ).not.toThrow();
    }
  });

  it('append() still rejects truly unknown kinds', () => {
    expect(() =>
      append({ kind: 'totally_made_up_kind' }, { projectRoot: tmpRoot }),
    ).toThrow(/entry.kind/);
  });
});

// ──────────────────────────────────────────────────────────────────
// readSince
// ──────────────────────────────────────────────────────────────────

describe('readSince', () => {
  it('returns only entries with seq > afterSeq', () => {
    append({ kind: 'state_transition', detail: { i: 1 } }, { projectRoot: tmpRoot });
    append({ kind: 'state_transition', detail: { i: 2 } }, { projectRoot: tmpRoot });
    append({ kind: 'state_transition', detail: { i: 3 } }, { projectRoot: tmpRoot });
    expect(readSince({ projectRoot: tmpRoot }, 1).map((e) => e.seq)).toEqual([2, 3]);
    expect(readSince({ projectRoot: tmpRoot }, 2).map((e) => e.seq)).toEqual([3]);
    expect(readSince({ projectRoot: tmpRoot }, 99)).toEqual([]);
  });

  it('returns all entries when afterSeq is undefined', () => {
    append({ kind: 'state_transition' }, { projectRoot: tmpRoot });
    append({ kind: 'state_transition' }, { projectRoot: tmpRoot });
    expect(readSince({ projectRoot: tmpRoot }, undefined as unknown as number)).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────
// tail iterator
// ──────────────────────────────────────────────────────────────────

describe('tail', () => {
  it('yields events appended after iteration starts (afterSeq=0 to see all)', async () => {
    append({ kind: 'state_transition', detail: { i: 1 } }, { projectRoot: tmpRoot });
    append({ kind: 'state_transition', detail: { i: 2 } }, { projectRoot: tmpRoot });

    const ctrl = new AbortController();
    const seenSeqs: number[] = [];
    const iter = tail(
      { projectRoot: tmpRoot },
      { afterSeq: 0, pollIntervalMs: 50, signal: ctrl.signal },
    );

    // Run the iterator and abort after the third event.
    for await (const event of iter) {
      seenSeqs.push(event.seq);
      if (seenSeqs.length === 2) {
        // Append one more event mid-iteration.
        setImmediate(() =>
          append({ kind: 'state_transition', detail: { i: 3 } }, { projectRoot: tmpRoot }),
        );
      }
      if (seenSeqs.length === 3) ctrl.abort();
    }
    expect(seenSeqs).toEqual([1, 2, 3]);
  });

  it('terminates on maxIdleMs when no new events arrive', async () => {
    append({ kind: 'state_transition' }, { projectRoot: tmpRoot });
    const start = Date.now();
    const events: LedgerEntry[] = [];
    for await (const event of tail(
      { projectRoot: tmpRoot },
      { afterSeq: 0, pollIntervalMs: 50, maxIdleMs: 200 },
    )) {
      events.push(event);
    }
    const elapsed = Date.now() - start;
    expect(events).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(2000); // not stuck
  });

  it('starts from current tail when afterSeq is omitted', async () => {
    append({ kind: 'state_transition', detail: { i: 1 } }, { projectRoot: tmpRoot });
    append({ kind: 'state_transition', detail: { i: 2 } }, { projectRoot: tmpRoot });
    const ctrl = new AbortController();
    const seenSeqs: number[] = [];
    const iter = tail({ projectRoot: tmpRoot }, { pollIntervalMs: 50, signal: ctrl.signal });

    // Append after a tick so the iterator sees ONLY the new one.
    setImmediate(() =>
      append({ kind: 'state_transition', detail: { i: 3 } }, { projectRoot: tmpRoot }),
    );

    for await (const event of iter) {
      seenSeqs.push(event.seq);
      if (seenSeqs.length === 1) ctrl.abort();
    }
    expect(seenSeqs).toEqual([3]);
  });

  it('respects AbortSignal mid-iteration', async () => {
    append({ kind: 'state_transition' }, { projectRoot: tmpRoot });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const events: LedgerEntry[] = [];
    for await (const event of tail(
      { projectRoot: tmpRoot },
      { afterSeq: 0, pollIntervalMs: 50, signal: ctrl.signal },
    )) {
      events.push(event);
    }
    // Should at least see the pre-existing event before abort.
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// `autopilot progress` CLI
// ──────────────────────────────────────────────────────────────────

describe('autopilot progress CLI', () => {
  function seedProjectWithStatus(): void {
    mkdirSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
      'development_status:\n  1-1-a: backlog\n',
    );
  }

  function seedPlan(stories: Array<Record<string, unknown>>): void {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = stories;
    writePlan(plan, { projectRoot: tmpRoot });
  }

  it('--json on a project with no plan returns plan_present=false', () => {
    seedProjectWithStatus();
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.plan_present).toBe(false);
    expect(parsed.sprint_progress.source).toBe('sprint-status');
  });

  it('--json with a plan returns counts + plan_id', () => {
    seedProjectWithStatus();
    seedPlan([
      { key: '1-1-a', plan_status: 'done', priority: 1 },
      { key: '1-2-b', plan_status: 'pending', priority: 2 },
      { key: '1-3-c', plan_status: 'skipped', priority: 3 },
      { key: '1-4-d', plan_status: 'excluded', priority: 4 },
    ]);
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.plan_present).toBe(true);
    expect(parsed.plan_id).toBeDefined();
    expect(parsed.sprint_progress).toMatchObject({
      total: 4,
      done: 1,
      pending: 1,
      skipped: 1,
      excluded: 1,
      source: 'plan',
    });
  });

  it('--json carries a next_summary line derived from the resume pointer + queue', () => {
    seedProjectWithStatus();
    seedPlan([
      { key: '21-1-x', plan_status: 'pending', priority: 1 },
      { key: '21-2-y', plan_status: 'pending', priority: 2 },
    ]);
    // Seed the resume pointer the way a paused mid-sprint session would.
    writeFileSync(
      join(tmpRoot, '_bmad-output', 'implementation-artifacts', 'autopilot-state.yaml'),
      [
        'current_story: "21-1-x"',
        'current_epic: "21"',
        'current_bmad_step: create_story',
        'story_queue: ["21-1-x", "21-2-y"]',
        '',
      ].join('\n'),
    );
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.next_summary).toBe('NEXT: 21-1-x · step create_story · #1 of 2 in epic 21');
  });

  it('--story <key> narrows output to the specified story', () => {
    seedProjectWithStatus();
    seedPlan([
      { key: '1-1-a', plan_status: 'pending', priority: 1, current_step: 'dev_green' },
      { key: '1-2-b', plan_status: 'pending', priority: 2 },
    ]);
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--story', '1-1-a', '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.story).toMatchObject({
      key: '1-1-a',
      plan_status: 'pending',
      current_step: 'dev_green',
    });
  });

  it('default human-readable mode includes the progress bar', () => {
    seedProjectWithStatus();
    seedPlan([
      { key: '1-1-a', plan_status: 'done', priority: 1 },
      { key: '1-2-b', plan_status: 'pending', priority: 2 },
    ]);
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot],
      { encoding: 'utf8' },
    );
    expect(out).toMatch(/Progress: 1\/2 done/);
    expect(out).toMatch(/Bar: \[=+\s+\] \d+%/);
  });

  it('surfaces recent step events when ledger has any', () => {
    seedProjectWithStatus();
    seedPlan([{ key: '1-1-a', plan_status: 'pending', priority: 1 }]);
    append(
      {
        kind: 'story_step_started',
        detail: { story_key: '1-1-a', step_name: 'dev_green', started_at: '2026-05-20T00:00:00Z' },
      },
      { projectRoot: tmpRoot },
    );
    append(
      {
        kind: 'story_step_completed',
        detail: { story_key: '1-1-a', step_name: 'dev_green', outcome: 'success' },
      },
      { projectRoot: tmpRoot },
    );
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.recent_events.length).toBeGreaterThanOrEqual(2);
    expect(parsed.recent_events[parsed.recent_events.length - 1]).toMatchObject({
      kind: 'story_step_completed',
      story_key: '1-1-a',
      step_name: 'dev_green',
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// v2.3.0 — issue_id enrichment in `autopilot progress` output
// ──────────────────────────────────────────────────────────────────

describe('autopilot progress — issue_id rendering', () => {
  function seedProjectWithStatus(): void {
    mkdirSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
      'development_status:\n  1-1-a: backlog\n',
    );
  }

  function seedPlanWithIssueIds(): void {
    const plan = (sprintPlanMod as { emptyPlan: (o: { source: string }) => Record<string, unknown> })
      .emptyPlan({ source: 'auto' });
    plan.issue_tracker = {
      provider: 'jira',
      base_url: 'https://co.atlassian.net',
      project_key: 'PROJ',
    };
    plan.stories = [
      { key: '1-1-a', plan_status: 'done', priority: 1, issue_id: 'PROJ-100' },
      {
        key: '1-2-b',
        plan_status: 'pending',
        priority: 2,
        issue_id: 'PROJ-101',
        current_step: 'dev_green',
      },
      // 1-3-c intentionally has no issue_id to test partial coverage.
      { key: '1-3-c', plan_status: 'pending', priority: 3 },
    ];
    (sprintPlanMod as {
      write: (p: Record<string, unknown>, opts: { projectRoot: string }) => string;
    }).write(plan, { projectRoot: tmpRoot });
  }

  it('--json includes issue_tracking summary when issue_tracker is configured', () => {
    seedProjectWithStatus();
    seedPlanWithIssueIds();
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.issue_tracking).toMatchObject({
      provider: 'jira',
      project_key: 'PROJ',
      total: 3,
      linked: 2,
      coverage: 67,
    });
    expect(parsed.issue_tracker).toMatchObject({ provider: 'jira', project_key: 'PROJ' });
  });

  it('--json includes issue_id on recent_events for stories that have one', () => {
    seedProjectWithStatus();
    seedPlanWithIssueIds();
    append(
      {
        kind: 'story_step_started',
        detail: { story_key: '1-2-b', step_name: 'dev_green', started_at: '2026-05-20T00:00:00Z' },
      },
      { projectRoot: tmpRoot },
    );
    append(
      {
        kind: 'story_step_started',
        detail: { story_key: '1-3-c', step_name: 'dev_red', started_at: '2026-05-20T00:00:00Z' },
      },
      { projectRoot: tmpRoot },
    );
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    const e1 = parsed.recent_events.find((e: { story_key: string }) => e.story_key === '1-2-b');
    const e2 = parsed.recent_events.find((e: { story_key: string }) => e.story_key === '1-3-c');
    expect(e1.issue_id).toBe('PROJ-101');
    expect(e2.issue_id).toBeNull();
  });

  it('--json sets current_issue_id when --story matches a story with an issue_id', () => {
    seedProjectWithStatus();
    seedPlanWithIssueIds();
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--story', '1-2-b', '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.current_issue_id).toBe('PROJ-101');
    expect(parsed.story).toMatchObject({ key: '1-2-b', issue_id: 'PROJ-101' });
  });

  it('issue_tracking is null when plan has no issue_tracker configured', () => {
    seedProjectWithStatus();
    const plan = (sprintPlanMod as { emptyPlan: (o: { source: string }) => Record<string, unknown> })
      .emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending', priority: 1, issue_id: 'X-1' }];
    // NOTE: issue_tracker intentionally null — even with issue_ids on stories,
    // the coverage line should not appear (no tracker provider to render against).
    (sprintPlanMod as {
      write: (p: Record<string, unknown>, opts: { projectRoot: string }) => string;
    }).write(plan, { projectRoot: tmpRoot });
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.issue_tracking).toBeNull();
  });

  it('human-readable mode renders [PROJ-101] bracket on --story output', () => {
    seedProjectWithStatus();
    seedPlanWithIssueIds();
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--story', '1-2-b'],
      { encoding: 'utf8' },
    );
    expect(out).toMatch(/Current story: 1-2-b \[PROJ-101\] \(step: dev_green\)/);
    expect(out).toMatch(/Issue tracking: 2\/3 stories linked to jira \(PROJ\)/);
  });

  it('human-readable Story-detail block renders Issue ID line cleanly (not raw JSON)', () => {
    seedProjectWithStatus();
    seedPlanWithIssueIds();
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--story', '1-2-b'],
      { encoding: 'utf8' },
    );
    expect(out).toMatch(/Story detail:/);
    expect(out).toMatch(/Issue ID:\s+PROJ-101/);
    expect(out).toMatch(/Current step:\s+dev_green/);
    // Should NOT have the old raw JSON.stringify output.
    expect(out).not.toContain('Story detail: {"key"');
  });

  it("human-readable Story detail shows '(not set)' when issue_id is null", () => {
    seedProjectWithStatus();
    seedPlanWithIssueIds();
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--story', '1-3-c'],
      { encoding: 'utf8' },
    );
    expect(out).toMatch(/Issue ID:\s+\(not set\)/);
  });

  it("human-readable mode does NOT print Issue tracking line when no tracker configured", () => {
    seedProjectWithStatus();
    const plan = (sprintPlanMod as { emptyPlan: (o: { source: string }) => Record<string, unknown> })
      .emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending', priority: 1 }];
    (sprintPlanMod as {
      write: (p: Record<string, unknown>, opts: { projectRoot: string }) => string;
    }).write(plan, { projectRoot: tmpRoot });
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot],
      { encoding: 'utf8' },
    );
    expect(out).not.toMatch(/Issue tracking:/);
  });

  it('recent step-event lines include [issue_id] when present', () => {
    seedProjectWithStatus();
    seedPlanWithIssueIds();
    append(
      {
        kind: 'story_step_started',
        detail: { story_key: '1-2-b', step_name: 'dev_green', started_at: '2026-05-20T00:00:00Z' },
      },
      { projectRoot: tmpRoot },
    );
    const out = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot],
      { encoding: 'utf8' },
    );
    // Line should be like:
    //   [42] HH:MM:SS step_started — 1-2-b [PROJ-101] / dev_green
    expect(out).toMatch(/step_started — 1-2-b \[PROJ-101\] \/ dev_green/);
  });
});
