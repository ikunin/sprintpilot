// Phase 3 — orchestrator-side sprint-plan helper.
//
// Covers: planStaleness truth table, bootstrapMigrationIfNeeded (legacy
// present / absent / corrupt), composePlanQueue (plan present + pending,
// all-terminal, missing plan), shouldAutoDerive (config opt-in matrix),
// refreshIfPlanExists best-effort behavior.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import sprintPlanMod from '../../_Sprintpilot/scripts/sprint-plan.js';
// @ts-expect-error — CommonJS module
import orchMod from '../../_Sprintpilot/lib/orchestrator/sprint-plan.js';

type Plan = {
  schema_version: number;
  plan_id: string;
  generated: string;
  source: string;
  status: { last_run_outcome: string; last_run_at: string; last_error: unknown };
  issue_tracker: unknown;
  epics: Array<Record<string, unknown>>;
  stories: Array<Record<string, unknown>>;
  dependencies: { version: number; auto_inferred_at: string | null; stories: Record<string, unknown> };
  cross_epic_deps: unknown[];
  overrides: unknown[];
  notes: string;
};

const { emptyPlan, write, planPath } = sprintPlanMod as {
  emptyPlan: (opts?: { source?: string }) => Plan;
  write: (plan: Plan, opts: { projectRoot: string }) => string;
  planPath: (root: string) => string;
};

const {
  STALENESS_REASONS,
  legacyDependenciesPath,
  readSprintStatusKeys,
  planStaleness,
  bootstrapMigrationIfNeeded,
  composePlanQueue,
  refreshIfPlanExists,
  shouldAutoDerive,
  planExhausted,
  planRejectionReason,
  collectUpstreams,
  isPlanTerminal,
  isTerminalInSprintStatus,
  validateOrdering,
} = orchMod as {
  STALENESS_REASONS: Record<string, string>;
  legacyDependenciesPath: (root: string) => string;
  readSprintStatusKeys: (root: string) => {
    exists: boolean;
    ordered: string[];
    byKey: Record<string, { key: string; status: string | null }>;
  };
  planStaleness: (opts: { projectRoot: string }) => {
    stale: boolean;
    reason?: string;
    missing_keys?: string[];
    removed_keys?: string[];
    error?: string;
    message?: string;
  };
  bootstrapMigrationIfNeeded: (opts: { projectRoot: string }) => {
    skipped?: boolean;
    migrated?: boolean;
    reason?: string;
    stories_imported?: number;
    overrides_imported?: number;
    epics_block_dropped?: boolean;
  };
  composePlanQueue: (opts: { projectRoot: string }) => string[] | null;
  refreshIfPlanExists: (opts: { projectRoot: string }) => {
    wrote: boolean;
    changed?: { stories: number; epics: number; transitions: number };
    reason?: string;
    message?: string;
  };
  shouldAutoDerive: (opts: {
    projectRoot: string;
    profile: Record<string, unknown>;
    opts?: Record<string, unknown>;
  }) => { auto_derive: boolean; reason: string; missing_keys?: string[] };
  planExhausted: (opts: { projectRoot: string }) => {
    exhausted: boolean;
    reason?: string;
    plan_id?: string;
    total?: number;
    terminal_counts?: { done: number; skipped: number; excluded: number };
  };
  planRejectionReason: (
    story_key: string,
    opts: { projectRoot: string },
  ) => string | null;
  collectUpstreams: (story_key: string, plan: Record<string, unknown>) => Set<string>;
  isPlanTerminal: (story_key: string, plan: Record<string, unknown>) => boolean;
  isTerminalInSprintStatus: (story_key: string, projectRoot: string) => boolean;
  validateOrdering: (
    proposedOrder: string[],
    plan: Record<string, unknown>,
    opts?: { projectRoot?: string },
  ) => {
    valid: boolean;
    violations: Array<{ story?: string; upstream?: string; suggestion?: string; reason?: string }>;
  };
};

let tmpRoot = '';

function seedSprintStatus(content: string): void {
  const impl = join(tmpRoot, '_bmad-output', 'implementation-artifacts');
  mkdirSync(impl, { recursive: true });
  writeFileSync(join(impl, 'sprint-status.yaml'), content);
}

function seedLegacyDependencies(content: string): void {
  const dir = join(tmpRoot, '_Sprintpilot', 'sprints');
  mkdirSync(dir, { recursive: true });
  writeFileSync(legacyDependenciesPath(tmpRoot), content);
}

function seedPlan(): Plan {
  const plan = emptyPlan({ source: 'auto' });
  write(plan, { projectRoot: tmpRoot });
  return plan;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-orch-'));
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

// ──────────────────────────────────────────────────────────────────
// readSprintStatusKeys
// ──────────────────────────────────────────────────────────────────

describe('readSprintStatusKeys', () => {
  it('returns exists:false when sprint-status.yaml is missing', () => {
    expect(readSprintStatusKeys(tmpRoot).exists).toBe(false);
  });

  it('extracts story keys under development_status', () => {
    seedSprintStatus('development_status:\n  1-1-a: backlog\n  1-2-b: ready-for-dev\n');
    const r = readSprintStatusKeys(tmpRoot);
    expect(r.exists).toBe(true);
    expect(r.ordered).toEqual(['1-1-a', '1-2-b']);
    expect(r.byKey['1-1-a'].status).toBe('backlog');
  });

  it('handles the alternate `stories:` block', () => {
    seedSprintStatus('stories:\n  1-1-a: backlog\n');
    expect(readSprintStatusKeys(tmpRoot).ordered).toEqual(['1-1-a']);
  });
});

// ──────────────────────────────────────────────────────────────────
// planStaleness
// ──────────────────────────────────────────────────────────────────

describe('planStaleness', () => {
  it("returns stale=true reason='missing' when neither plan nor legacy exists", () => {
    const r = planStaleness({ projectRoot: tmpRoot });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe(STALENESS_REASONS.missing);
  });

  it("returns stale=true reason='migration_needed' when only legacy exists", () => {
    seedLegacyDependencies('version: 1\nstories: {}\noverrides: []\nepics: {}\n');
    const r = planStaleness({ projectRoot: tmpRoot });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe(STALENESS_REASONS.migration_needed);
  });

  it('returns stale=false when plan exists and sprint-status is empty', () => {
    seedPlan();
    expect(planStaleness({ projectRoot: tmpRoot }).stale).toBe(false);
  });

  it("returns stale=true reason='added_stories' when sprint-status has keys not in plan", () => {
    seedPlan();
    seedSprintStatus('development_status:\n  1-1-a: backlog\n  1-2-b: backlog\n');
    const r = planStaleness({ projectRoot: tmpRoot });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe(STALENESS_REASONS.added_stories);
    expect(r.missing_keys).toEqual(['1-1-a', '1-2-b']);
  });

  it("returns stale=true reason='removed_stories' when plan has keys absent from sprint-status", () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [
      { key: '1-1-a', plan_status: 'pending' },
      { key: '1-2-b', plan_status: 'pending' },
    ];
    write(plan, { projectRoot: tmpRoot });
    seedSprintStatus('development_status:\n  1-1-a: backlog\n');
    const r = planStaleness({ projectRoot: tmpRoot });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe(STALENESS_REASONS.removed_stories);
    expect(r.removed_keys).toEqual(['1-2-b']);
  });

  it("returns stale=true reason='corrupt' when sprint-plan.yaml is unparseable", () => {
    mkdirSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(planPath(tmpRoot), 'broken: : yaml :\n');
    const r = planStaleness({ projectRoot: tmpRoot });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe('corrupt');
  });

  it('returns stale=false when plan covers every sprint-status key', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [
      { key: '1-1-a', plan_status: 'pending' },
      { key: '1-2-b', plan_status: 'done' },
    ];
    write(plan, { projectRoot: tmpRoot });
    seedSprintStatus('development_status:\n  1-1-a: backlog\n  1-2-b: done\n');
    expect(planStaleness({ projectRoot: tmpRoot }).stale).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// bootstrapMigrationIfNeeded
// ──────────────────────────────────────────────────────────────────

describe('bootstrapMigrationIfNeeded', () => {
  it('skips when no legacy file exists', () => {
    const r = bootstrapMigrationIfNeeded({ projectRoot: tmpRoot });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_legacy_file');
  });

  it('imports stories + overrides from a valid legacy file', () => {
    seedSprintStatus('development_status:\n  1-1-a: backlog\n');
    seedLegacyDependencies(
      [
        'version: 1',
        'stories:',
        '  1-1-a:',
        '    depends_on: []',
        '    rationale: r',
        'overrides:',
        '  - epic: "1"',
        '    force_independent: []',
        '    force_sequential: []',
        'epics: {}',
        '',
      ].join('\n'),
    );
    const r = bootstrapMigrationIfNeeded({ projectRoot: tmpRoot });
    expect(r.migrated).toBe(true);
    expect(r.stories_imported).toBe(1);
    expect(existsSync(planPath(tmpRoot))).toBe(true);
    expect(existsSync(legacyDependenciesPath(tmpRoot))).toBe(false);
  });

  it('surfaces migrate_failed when the legacy file is corrupt', () => {
    seedLegacyDependencies('broken: : yaml :\n');
    const r = bootstrapMigrationIfNeeded({ projectRoot: tmpRoot });
    expect(r.migrated).toBe(false);
    expect(r.reason).toBeDefined();
    // Migrate exits 1 with parse_error inside the parsed envelope.
    // The bootstrap returns reason='migrate_failed' or the parsed reason
    // depending on how the script ran. Either way migrated is false.
    expect(['migrate_failed', 'parse_error']).toContain(r.reason);
  });
});

// ──────────────────────────────────────────────────────────────────
// composePlanQueue
// ──────────────────────────────────────────────────────────────────

describe('composePlanQueue', () => {
  it('returns null when no plan exists', () => {
    expect(composePlanQueue({ projectRoot: tmpRoot })).toBeNull();
  });

  it('returns null when sprint-plan.yaml is corrupt', () => {
    mkdirSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(planPath(tmpRoot), 'broken: : yaml :\n');
    expect(composePlanQueue({ projectRoot: tmpRoot })).toBeNull();
  });

  it('returns null when plan.stories is empty (skill curation not done)', () => {
    seedPlan();
    expect(composePlanQueue({ projectRoot: tmpRoot })).toBeNull();
  });

  it('returns only stories whose plan_status is pending, ordered by priority', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [
      { key: 'c', plan_status: 'pending', priority: 3 },
      { key: 'a', plan_status: 'pending', priority: 1 },
      { key: 'done-one', plan_status: 'done', priority: 0 },
      { key: 'b', plan_status: 'pending', priority: 2 },
      { key: 'skipped-one', plan_status: 'skipped', priority: 99 },
      { key: 'excluded-one', plan_status: 'excluded', priority: 100 },
    ];
    write(plan, { projectRoot: tmpRoot });
    expect(composePlanQueue({ projectRoot: tmpRoot })).toEqual(['a', 'b', 'c']);
  });

  it('sinks stories without a priority to the end', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [
      { key: 'nopri-1', plan_status: 'pending' },
      { key: 'a', plan_status: 'pending', priority: 1 },
    ];
    write(plan, { projectRoot: tmpRoot });
    expect(composePlanQueue({ projectRoot: tmpRoot })).toEqual(['a', 'nopri-1']);
  });
});

// ──────────────────────────────────────────────────────────────────
// refreshIfPlanExists (best-effort wrapper)
// ──────────────────────────────────────────────────────────────────

describe('refreshIfPlanExists', () => {
  it('returns no_plan reason when no plan file exists', () => {
    const r = refreshIfPlanExists({ projectRoot: tmpRoot });
    expect(r.wrote).toBe(false);
    expect(r.reason).toBe('no_plan');
  });

  it('updates bmad_status cache when a plan exists', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending' }];
    write(plan, { projectRoot: tmpRoot });
    seedSprintStatus('development_status:\n  1-1-a: in-progress\n');
    const r = refreshIfPlanExists({ projectRoot: tmpRoot });
    expect(r.wrote).toBe(true);
    expect(r.changed?.stories).toBeGreaterThan(0);
  });

  it('eagerly transitions terminal-bmad-status stories to plan_status=done', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending' }];
    write(plan, { projectRoot: tmpRoot });
    seedSprintStatus('development_status:\n  1-1-a: done\n');
    const r = refreshIfPlanExists({ projectRoot: tmpRoot });
    expect(r.wrote).toBe(true);
    expect(r.changed?.transitions).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// shouldAutoDerive (config gating)
// ──────────────────────────────────────────────────────────────────

describe('shouldAutoDerive', () => {
  it('suppresses auto-derive when --no-auto-plan is set', () => {
    const r = shouldAutoDerive({
      projectRoot: tmpRoot,
      profile: { auto_plan_on_start: true },
      opts: { 'no-auto-plan': true },
    });
    expect(r.auto_derive).toBe(false);
    expect(r.reason).toBe('no_auto_plan_flag');
  });

  it('suppresses auto-derive when --stories is set', () => {
    const r = shouldAutoDerive({
      projectRoot: tmpRoot,
      profile: { auto_plan_on_start: true },
      opts: { stories: ['1-1-a'] },
    });
    expect(r.auto_derive).toBe(false);
    expect(r.reason).toBe('explicit_stories_flag');
  });

  it('suppresses auto-derive when --epic is set', () => {
    const r = shouldAutoDerive({
      projectRoot: tmpRoot,
      profile: { auto_plan_on_start: true },
      opts: { epic: '1' },
    });
    expect(r.auto_derive).toBe(false);
    expect(r.reason).toBe('explicit_epic_flag');
  });

  it('greenfield (no plan, no opt-in) falls back to sprint-status order — no auto-derive', () => {
    const r = shouldAutoDerive({
      projectRoot: tmpRoot,
      profile: { auto_plan_on_start: false },
      opts: {},
    });
    expect(r.auto_derive).toBe(false);
    expect(r.reason).toBe('greenfield_default_no_auto_plan');
  });

  it('greenfield + auto_plan_on_start=true → auto-derive', () => {
    const r = shouldAutoDerive({
      projectRoot: tmpRoot,
      profile: { auto_plan_on_start: true },
      opts: {},
    });
    expect(r.auto_derive).toBe(true);
    expect(r.reason).toBe('opt_in_missing');
  });

  it('migration-needed (legacy file present) → not auto-derive (migration runs separately)', () => {
    seedLegacyDependencies('version: 1\nstories: {}\noverrides: []\nepics: {}\n');
    const r = shouldAutoDerive({
      projectRoot: tmpRoot,
      profile: { auto_plan_on_start: false },
      opts: {},
    });
    expect(r.auto_derive).toBe(false);
    expect(r.reason).toBe('migration_only');
  });

  it('plan exists + stale (added_stories) → auto-derive regardless of config knob', () => {
    seedPlan();
    seedSprintStatus('development_status:\n  1-1-a: backlog\n');
    const r = shouldAutoDerive({
      projectRoot: tmpRoot,
      profile: { auto_plan_on_start: false }, // knob OFF but plan is stale
      opts: {},
    });
    expect(r.auto_derive).toBe(true);
    expect(r.reason).toBe('stale_added_stories');
    expect(r.missing_keys).toEqual(['1-1-a']);
  });

  it('plan exists and fresh → no auto-derive', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending' }];
    write(plan, { projectRoot: tmpRoot });
    seedSprintStatus('development_status:\n  1-1-a: backlog\n');
    const r = shouldAutoDerive({
      projectRoot: tmpRoot,
      profile: { auto_plan_on_start: true },
      opts: {},
    });
    expect(r.auto_derive).toBe(false);
    expect(r.reason).toBe('plan_fresh');
  });
});

// ──────────────────────────────────────────────────────────────────
// planExhausted
// ──────────────────────────────────────────────────────────────────

describe('planExhausted', () => {
  it("reason='no_plan' when no plan file exists", () => {
    const r = planExhausted({ projectRoot: tmpRoot });
    expect(r.exhausted).toBe(false);
    expect(r.reason).toBe('no_plan');
  });

  it("reason='corrupt_plan' when plan exists but is unreadable", () => {
    mkdirSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(planPath(tmpRoot), 'broken: : yaml :\n');
    const r = planExhausted({ projectRoot: tmpRoot });
    expect(r.exhausted).toBe(false);
    expect(r.reason).toBe('corrupt_plan');
  });

  it("reason='empty_stories' when plan exists but stories=[] (skill not yet curated)", () => {
    seedPlan();
    const r = planExhausted({ projectRoot: tmpRoot });
    expect(r.exhausted).toBe(false);
    expect(r.reason).toBe('empty_stories');
  });

  it("reason='has_pending' when at least one story is pending", () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [
      { key: 'a', plan_status: 'done' },
      { key: 'b', plan_status: 'pending' },
    ];
    write(plan, { projectRoot: tmpRoot });
    const r = planExhausted({ projectRoot: tmpRoot });
    expect(r.exhausted).toBe(false);
    expect(r.reason).toBe('has_pending');
  });

  it('exhausted=true with terminal_counts when every story is terminal', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [
      { key: 'a', plan_status: 'done' },
      { key: 'b', plan_status: 'done' },
      { key: 'c', plan_status: 'skipped' },
      { key: 'd', plan_status: 'excluded' },
    ];
    write(plan, { projectRoot: tmpRoot });
    const r = planExhausted({ projectRoot: tmpRoot });
    expect(r.exhausted).toBe(true);
    expect(r.total).toBe(4);
    expect(r.terminal_counts).toEqual({ done: 2, skipped: 1, excluded: 1 });
    expect(r.plan_id).toBe(plan.plan_id);
  });
});

// ──────────────────────────────────────────────────────────────────
// planRejectionReason
// ──────────────────────────────────────────────────────────────────

describe('planRejectionReason', () => {
  it('returns null when no plan exists (greenfield projects unaffected)', () => {
    expect(planRejectionReason('1-1-a', { projectRoot: tmpRoot })).toBeNull();
  });

  it("returns null when the key isn't in the plan", () => {
    seedPlan();
    expect(planRejectionReason('1-1-a', { projectRoot: tmpRoot })).toBeNull();
  });

  it('returns null for plan_status=pending', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending' }];
    write(plan, { projectRoot: tmpRoot });
    expect(planRejectionReason('1-1-a', { projectRoot: tmpRoot })).toBeNull();
  });

  it("returns reason for plan_status='done'", () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'done' }];
    write(plan, { projectRoot: tmpRoot });
    expect(planRejectionReason('1-1-a', { projectRoot: tmpRoot })).toMatch(/plan_status='done'/);
  });

  it("returns reason for plan_status='skipped'", () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'skipped' }];
    write(plan, { projectRoot: tmpRoot });
    expect(planRejectionReason('1-1-a', { projectRoot: tmpRoot })).toMatch(/plan_status='skipped'/);
  });

  it("returns reason for plan_status='excluded'", () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'excluded' }];
    write(plan, { projectRoot: tmpRoot });
    expect(planRejectionReason('1-1-a', { projectRoot: tmpRoot })).toMatch(/plan_status='excluded'/);
  });

  it("returns null when the plan is corrupt (defensive — doesn't reject on read failure)", () => {
    mkdirSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(planPath(tmpRoot), 'broken: : yaml :\n');
    expect(planRejectionReason('1-1-a', { projectRoot: tmpRoot })).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// collectUpstreams
// ──────────────────────────────────────────────────────────────────

describe('collectUpstreams', () => {
  function buildPlan(deps: Record<string, string[]>, cross: Array<{ from: string; to: string }> = []) {
    const plan = emptyPlan({ source: 'auto' });
    plan.dependencies.stories = Object.fromEntries(
      Object.entries(deps).map(([k, depsList]) => [k, { depends_on: depsList, rationale: 'r' }]),
    );
    plan.cross_epic_deps = cross.map((e) => ({
      from_story: e.from,
      to_story: e.to,
      rationale: 'r',
    }));
    return plan;
  }

  it('returns an empty Set when the plan has no dependencies', () => {
    expect(collectUpstreams('a', emptyPlan({ source: 'auto' })).size).toBe(0);
  });

  it('collects direct intra-epic upstreams', () => {
    const plan = buildPlan({ a: ['b', 'c'] });
    expect([...collectUpstreams('a', plan)].sort()).toEqual(['b', 'c']);
  });

  it('traverses transitively (a depends on b depends on c)', () => {
    const plan = buildPlan({ a: ['b'], b: ['c'] });
    expect([...collectUpstreams('a', plan)].sort()).toEqual(['b', 'c']);
  });

  it('includes cross-epic upstreams (from_story is the dependent)', () => {
    const plan = buildPlan({}, [{ from: '2-1-foo', to: '1-3-add-auth' }]);
    expect([...collectUpstreams('2-1-foo', plan)]).toEqual(['1-3-add-auth']);
  });

  it('avoids infinite loops on a cycle (idempotent set)', () => {
    const plan = buildPlan({ a: ['b'], b: ['a'] });
    // Plan validation would have caught this in the real flow; collectUpstreams
    // still terminates cleanly.
    const ups = collectUpstreams('a', plan);
    expect(ups.has('b')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// isPlanTerminal / isTerminalInSprintStatus
// ──────────────────────────────────────────────────────────────────

describe('isPlanTerminal', () => {
  it("returns true for plan_status in {done, skipped, excluded}", () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [
      { key: 'a', plan_status: 'done' },
      { key: 'b', plan_status: 'skipped' },
      { key: 'c', plan_status: 'excluded' },
    ];
    expect(isPlanTerminal('a', plan)).toBe(true);
    expect(isPlanTerminal('b', plan)).toBe(true);
    expect(isPlanTerminal('c', plan)).toBe(true);
  });

  it('returns false for plan_status=pending', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: 'a', plan_status: 'pending' }];
    expect(isPlanTerminal('a', plan)).toBe(false);
  });

  it('returns false for stories absent from the plan', () => {
    expect(isPlanTerminal('zzz', emptyPlan({ source: 'auto' }))).toBe(false);
  });
});

describe('isTerminalInSprintStatus', () => {
  it('returns true for done/skipped/wont_do/cancelled/abandoned/etc', () => {
    for (const status of ['done', 'skipped', 'wont_do', 'cancelled', 'canceled', 'deferred', 'abandoned']) {
      seedSprintStatus(`development_status:\n  s-1: ${status}\n`);
      expect(isTerminalInSprintStatus('s-1', tmpRoot)).toBe(true);
    }
  });

  it('returns false for non-terminal statuses', () => {
    seedSprintStatus('development_status:\n  s-1: backlog\n  s-2: in-progress\n');
    expect(isTerminalInSprintStatus('s-1', tmpRoot)).toBe(false);
    expect(isTerminalInSprintStatus('s-2', tmpRoot)).toBe(false);
  });

  it('returns false when sprint-status.yaml is missing', () => {
    expect(isTerminalInSprintStatus('s-1', tmpRoot)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// validateOrdering — the DAG reorder validator
// ──────────────────────────────────────────────────────────────────

describe('validateOrdering', () => {
  function buildPlan(
    deps: Record<string, string[]>,
    stories: Array<{ key: string; plan_status?: string }> = [],
    cross: Array<{ from: string; to: string }> = [],
  ) {
    const plan = emptyPlan({ source: 'auto' });
    plan.dependencies.stories = Object.fromEntries(
      Object.entries(deps).map(([k, depsList]) => [k, { depends_on: depsList, rationale: 'r' }]),
    );
    plan.stories = stories.map((s) => ({ key: s.key, plan_status: s.plan_status || 'pending' }));
    plan.cross_epic_deps = cross.map((e) => ({
      from_story: e.from,
      to_story: e.to,
      rationale: 'r',
    }));
    return plan;
  }

  it('accepts an order that respects all upstreams', () => {
    const plan = buildPlan({ a: ['b'], b: ['c'] });
    const r = validateOrdering(['c', 'b', 'a'], plan);
    expect(r.valid).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('rejects an order where an upstream is positioned after its dependent', () => {
    const plan = buildPlan({ a: ['b'] });
    const r = validateOrdering(['a', 'b'], plan);
    expect(r.valid).toBe(false);
    expect(r.violations[0]).toMatchObject({ story: 'a', upstream: 'b' });
    expect(r.violations[0].suggestion).toMatch(/insert b before a/);
  });

  it('accepts an order when the missing upstream is plan-terminal', () => {
    const plan = buildPlan({ a: ['b'] }, [{ key: 'b', plan_status: 'done' }]);
    const r = validateOrdering(['a'], plan);
    expect(r.valid).toBe(true);
  });

  it('accepts an order when the missing upstream is terminal in sprint-status', () => {
    const plan = buildPlan({ a: ['b'] });
    seedSprintStatus('development_status:\n  a: backlog\n  b: done\n');
    const r = validateOrdering(['a'], plan, { projectRoot: tmpRoot });
    expect(r.valid).toBe(true);
  });

  it('reports every violating pair', () => {
    const plan = buildPlan({ a: ['b'], c: ['d'] });
    const r = validateOrdering(['a', 'c'], plan);
    expect(r.valid).toBe(false);
    expect(r.violations).toHaveLength(2);
  });

  it('respects transitive upstreams (a depends on b depends on c)', () => {
    const plan = buildPlan({ a: ['b'], b: ['c'] });
    // c is missing entirely from the proposed order
    const r = validateOrdering(['b', 'a'], plan);
    expect(r.valid).toBe(false);
    // Both a and b complain about missing c
    const upstreams = r.violations.map((v) => v.upstream).sort();
    expect(upstreams).toContain('c');
  });

  it('respects cross-epic upstreams', () => {
    const plan = buildPlan({}, [], [{ from: '2-1-foo', to: '1-3-add-auth' }]);
    const r = validateOrdering(['2-1-foo'], plan);
    expect(r.valid).toBe(false);
    expect(r.violations[0]).toMatchObject({
      story: '2-1-foo',
      upstream: '1-3-add-auth',
    });
  });

  it('rejects non-array input cleanly', () => {
    const r = validateOrdering(null as unknown as string[], emptyPlan({ source: 'auto' }));
    expect(r.valid).toBe(false);
  });
});
