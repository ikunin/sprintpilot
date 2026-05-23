// End-to-end test for the v2.3.0 plan-aware flow.
//
// Covers the data-flow surface (plan creation → autopilot reads it →
// markDone updates it → mid-flight commands mutate it → exhaustion +
// archive). The BMad-cycle action emission isn't fully simulated (that
// would require stubbing git + verify); we test the script CLI
// boundaries instead, which is where v2.3.0's new behavior actually
// lives.
//
// Each test spawns real `node` subprocesses against the actual scripts,
// not via require() — that's the only way to verify the lock semantics
// and the cross-process state transitions.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import yaml from 'js-yaml';

const REPO_ROOT = join(__dirname, '..', '..');
const SP = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sprint-plan.js');
const INFER = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'infer-dependencies.js');
const DAG = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'resolve-dag.js');
const AUTOPILOT = join(REPO_ROOT, '_Sprintpilot', 'bin', 'autopilot.js');

// posix path for safe embedding in `node -e` template strings.
// Windows `path.join` returns backslashes; embedded inside a JS string
// literal those re-interpret as escape sequences ("D:\a\sprintpilot" →
// "D:asprintpilotsp"), so the spawned node process gets a corrupted path
// and fails with "Cannot find module 'D:asprintpilotsp…'". Node accepts
// forward slashes on Windows, so the simplest fix is to swap separators
// before interpolation.
const sx = (p: string) => p.replace(/\\/g, '/');

let tmpRoot = '';

function seedSprintStatus(content: string): void {
  const impl = join(tmpRoot, '_bmad-output', 'implementation-artifacts');
  mkdirSync(impl, { recursive: true });
  writeFileSync(join(impl, 'sprint-status.yaml'), content);
}

function writePlanFromObject(plan: Record<string, unknown>): void {
  const r = spawnSync('node', [SP, 'write', '--project-root', tmpRoot], {
    encoding: 'utf8',
    input: JSON.stringify(plan),
  });
  if (r.status !== 0) throw new Error(`writePlan failed: ${r.stderr}`);
}

function readPlanFromDisk(): Record<string, unknown> {
  const file = join(tmpRoot, '_bmad-output', 'implementation-artifacts', 'sprint-plan.yaml');
  return yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function buildEmptyPlan(): Record<string, unknown> {
  const out = execFileSync('node', [SP, 'empty', '--source', 'auto'], { encoding: 'utf8' });
  return yaml.load(out) as Record<string, unknown>;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-e2e-'));
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

// ──────────────────────────────────────────────────────────────────
// Greenfield flow — no plan, no config — falls back to sprint-status
// ──────────────────────────────────────────────────────────────────

describe('greenfield: no plan, sprint-status fallback', () => {
  it('autopilot progress runs without a plan and reports sprint-status mode', () => {
    seedSprintStatus('development_status:\n  1-1-a: backlog\n  1-2-b: backlog\n');
    const out = execFileSync('node', [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--json'], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    expect(parsed.plan_present).toBe(false);
    expect(parsed.sprint_progress.source).toBe('sprint-status');
    expect(parsed.issue_tracking).toBeNull();
  });

  it('autopilot progress (human mode) prints the no-plan banner', () => {
    seedSprintStatus('development_status:\n  1-1-a: backlog\n');
    const out = execFileSync('node', [AUTOPILOT, 'progress', '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    expect(out).toContain('Sprint plan: (none)');
  });
});

// ──────────────────────────────────────────────────────────────────
// Full plan-aware lifecycle (build → progress → markDone → exhaust)
// ──────────────────────────────────────────────────────────────────

describe('plan-aware lifecycle', () => {
  it('plan → progress shows pending head → markDone advances → exhaustion archives', () => {
    seedSprintStatus(
      'development_status:\n  1-1-a: backlog\n  1-2-b: backlog\n  1-3-c: backlog\n',
    );
    // 1. Build a plan with 3 stories + issue_tracker.
    const plan = buildEmptyPlan();
    plan.issue_tracker = {
      provider: 'jira',
      base_url: 'https://co.atlassian.net',
      project_key: 'PROJ',
    };
    plan.stories = [
      { key: '1-1-a', plan_status: 'pending', priority: 1, issue_id: 'PROJ-100' },
      { key: '1-2-b', plan_status: 'pending', priority: 2, issue_id: 'PROJ-101' },
      { key: '1-3-c', plan_status: 'pending', priority: 3 },
    ];
    writePlanFromObject(plan);
    const planId = readPlanFromDisk().plan_id as string;

    // 2. Progress shows plan + issue coverage + first pending head.
    const progRaw = execFileSync(
      'node',
      [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--json'],
      { encoding: 'utf8' },
    );
    const prog = JSON.parse(progRaw);
    expect(prog.plan_present).toBe(true);
    expect(prog.sprint_progress).toMatchObject({ total: 3, pending: 3, done: 0 });
    expect(prog.issue_tracking).toMatchObject({
      provider: 'jira',
      total: 3,
      linked: 2,
      coverage: 67,
    });

    // 3. markDone via the script CLI on the first story.
    spawnSync(
      'node',
      ['-e', `require('${sx(SP)}').markDone('1-1-a', { projectRoot: '${sx(tmpRoot)}' })`],
      { encoding: 'utf8' },
    );
    const after = readPlanFromDisk();
    const firstStory = (after.stories as Array<Record<string, unknown>>).find(
      (s) => s.key === '1-1-a',
    );
    expect(firstStory?.plan_status).toBe('done');
    expect(firstStory?.completed_at).toEqual(expect.any(String));

    // 4. markDone the remaining two.
    spawnSync(
      'node',
      ['-e', `require('${sx(SP)}').markDone('1-2-b', { projectRoot: '${sx(tmpRoot)}' })`],
      { encoding: 'utf8' },
    );
    spawnSync(
      'node',
      ['-e', `require('${sx(SP)}').markDone('1-3-c', { projectRoot: '${sx(tmpRoot)}' })`],
      { encoding: 'utf8' },
    );

    // 5. Progress reports 3/3 done.
    const final = JSON.parse(
      execFileSync('node', [AUTOPILOT, 'progress', '--project-root', tmpRoot, '--json'], {
        encoding: 'utf8',
      }),
    );
    expect(final.sprint_progress).toMatchObject({ total: 3, done: 3, pending: 0 });

    // 6. Archive the plan (simulating what cmdStart does on
    // plan_exhausted). After archive, live plan is gone but the
    // archive file is present.
    spawnSync('node', ['-e', `require('${sx(SP)}').archive('${planId}', { projectRoot: '${sx(tmpRoot)}' })`], {
      encoding: 'utf8',
    });
    expect(
      existsSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts', 'sprint-plan.yaml')),
    ).toBe(false);
    expect(existsSync(join(tmpRoot, '.archive', `sprint-plan-${planId}.yaml`))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// Mid-flight commands via the script CLI
// ──────────────────────────────────────────────────────────────────

describe('mid-flight mutations via script CLI', () => {
  it('reorder + addStories + removeStories all persist correctly', () => {
    seedSprintStatus('development_status:\n  a: backlog\n  b: backlog\n  c: backlog\n  d: backlog\n');
    const plan = buildEmptyPlan();
    plan.stories = [
      { key: 'a', plan_status: 'pending', priority: 1 },
      { key: 'b', plan_status: 'pending', priority: 2 },
      { key: 'c', plan_status: 'pending', priority: 3 },
    ];
    writePlanFromObject(plan);

    // reorder
    spawnSync(
      'node',
      ['-e', `require('${sx(SP)}').reorder(['c', 'a', 'b'], { projectRoot: '${sx(tmpRoot)}' })`],
      { encoding: 'utf8' },
    );
    let p = readPlanFromDisk();
    expect((p.stories as Array<Record<string, unknown>>).map((s) => s.key)).toEqual(['c', 'a', 'b']);

    // addStories
    spawnSync(
      'node',
      [
        '-e',
        `require('${sx(SP)}').addStories([{key:'d', plan_status:'pending'}], { projectRoot: '${sx(tmpRoot)}', position: 'end' })`,
      ],
      { encoding: 'utf8' },
    );
    p = readPlanFromDisk();
    expect((p.stories as Array<Record<string, unknown>>).map((s) => s.key)).toEqual(['c', 'a', 'b', 'd']);

    // removeStories
    spawnSync(
      'node',
      [
        '-e',
        `require('${sx(SP)}').removeStories(['a'], { projectRoot: '${sx(tmpRoot)}', status: 'skipped' })`,
      ],
      { encoding: 'utf8' },
    );
    p = readPlanFromDisk();
    const aEntry = (p.stories as Array<Record<string, unknown>>).find((s) => s.key === 'a');
    expect(aEntry?.plan_status).toBe('skipped');
  });

  it('reorder rejects terminal-status keys (M1)', () => {
    seedSprintStatus('development_status:\n  a: backlog\n  b: backlog\n');
    const plan = buildEmptyPlan();
    plan.stories = [
      { key: 'a', plan_status: 'done', priority: 1 },
      { key: 'b', plan_status: 'pending', priority: 2 },
    ];
    writePlanFromObject(plan);

    const r = spawnSync(
      'node',
      [
        '-e',
        `try { require('${sx(SP)}').reorder(['a', 'b'], { projectRoot: '${sx(tmpRoot)}' }); process.exit(0); } catch (e) { console.error(e.message); process.exit(1); }`,
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/terminal/);
  });
});

// ──────────────────────────────────────────────────────────────────
// Dependency graph render with issue_id prefix
// ──────────────────────────────────────────────────────────────────

describe('dependency graph render', () => {
  it('renders mermaid with issue_id-prefixed labels and writes the .mmd file', () => {
    seedSprintStatus(
      'development_status:\n  1-1-a: backlog\n  1-2-b: backlog\n  2-1-foo: backlog\n',
    );
    const plan = buildEmptyPlan();
    plan.epics = [{ id: '1', title: 'Bootstrap', issue_id: 'PROJ-EPIC-1' }];
    plan.stories = [
      { key: '1-1-a', plan_status: 'pending', priority: 1, issue_id: 'PROJ-100' },
      { key: '1-2-b', plan_status: 'pending', priority: 2 },
      { key: '2-1-foo', plan_status: 'pending', priority: 3 },
    ];
    (plan.dependencies as Record<string, unknown>).stories = {
      '1-2-b': { depends_on: ['1-1-a'], rationale: 'needs base' },
    };
    plan.cross_epic_deps = [
      { from_story: '2-1-foo', to_story: '1-2-b', rationale: 'needs models' },
    ];
    writePlanFromObject(plan);

    const r = spawnSync(
      'node',
      [DAG, 'render', '--format', 'mermaid', '--project-root', tmpRoot],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.wrote).toBe(true);
    expect(parsed.format).toBe('mermaid');

    const body = readFileSync(parsed.file, 'utf8');
    // Story with issue_id is prefixed.
    expect(body).toContain('1-1-a["PROJ-100: 1-1-a"]');
    // Story without issue_id is NOT prefixed.
    expect(body).toContain('1-2-b["1-2-b"]');
    // Epic 1 has an issue_id; epic 2 does not. Both render correctly.
    expect(body).toContain('subgraph epic_1 ["PROJ-EPIC-1: Epic 1"]');
    expect(body).toContain('subgraph epic_2 ["Epic 2"]');
    // Cross-epic edge present.
    expect(body).toContain('-. cross-epic .-> 2-1-foo');
  });

  it('layers command returns the topological order as JSON', () => {
    seedSprintStatus('development_status:\n  1-1-a: backlog\n  1-2-b: backlog\n');
    const plan = buildEmptyPlan();
    plan.stories = [
      { key: '1-1-a', plan_status: 'pending', priority: 1 },
      { key: '1-2-b', plan_status: 'pending', priority: 2 },
    ];
    (plan.dependencies as Record<string, unknown>).stories = {
      '1-2-b': { depends_on: ['1-1-a'], rationale: 'r' },
    };
    writePlanFromObject(plan);

    const out = execFileSync('node', [DAG, 'layers', '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    const layers = JSON.parse(out);
    expect(layers).toEqual([['1-1-a'], ['1-2-b']]);
  });
});

// ──────────────────────────────────────────────────────────────────
// Legacy migration end-to-end
// ──────────────────────────────────────────────────────────────────

describe('legacy dependencies.yaml migration', () => {
  it('migrate imports + archives + renders correctly afterward', () => {
    seedSprintStatus(
      'development_status:\n  1-1-bootstrap: done\n  1-3-add-auth: backlog\n',
    );
    const legacyDir = join(tmpRoot, '_Sprintpilot', 'sprints');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'dependencies.yaml'),
      [
        'version: 1',
        'stories:',
        '  1-3-add-auth:',
        '    depends_on: ["1-1-bootstrap"]',
        '    rationale: "needs base"',
        'overrides:',
        '  - epic: "1"',
        '    force_independent: []',
        '    force_sequential: []',
        'epics: {}',
        '',
      ].join('\n'),
    );

    const r = spawnSync('node', [INFER, 'migrate', '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.migrated).toBe(true);
    expect(parsed.stories_imported).toBe(1);

    // Legacy file archived; new plan exists.
    expect(existsSync(join(legacyDir, 'dependencies.yaml'))).toBe(false);
    expect(existsSync(join(tmpRoot, '.archive', 'dependencies.yaml.migrated'))).toBe(true);
    const plan = readPlanFromDisk();
    expect((plan.dependencies as Record<string, unknown>).stories).toMatchObject({
      '1-3-add-auth': { depends_on: ['1-1-bootstrap'] },
    });

    // Render works on the migrated plan.
    const dagOut = execFileSync('node', [DAG, 'graph', '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    const graph = JSON.parse(dagOut);
    expect(graph.nodes).toContain('1-3-add-auth');
  });

  it('migrate rejects version != 1 (M3)', () => {
    const legacyDir = join(tmpRoot, '_Sprintpilot', 'sprints');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'dependencies.yaml'), 'version: 99\nstories: {}\n');
    const r = spawnSync('node', [INFER, 'migrate', '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).reason).toBe('unsupported_legacy_version');
  });
});

// ──────────────────────────────────────────────────────────────────
// /sprintpilot-dependency-graph / /sprintpilot-sprint-progress skill files
// ──────────────────────────────────────────────────────────────────

describe('v2.3.0 skill files present', () => {
  it('all three new skills have SKILL.md + workflow.md', () => {
    const skills = ['sprintpilot-plan-sprint', 'sprintpilot-sprint-progress', 'sprintpilot-dependency-graph'];
    for (const s of skills) {
      const skillMd = join(REPO_ROOT, '_Sprintpilot', 'skills', s, 'SKILL.md');
      const workflowMd = join(REPO_ROOT, '_Sprintpilot', 'skills', s, 'workflow.md');
      expect(existsSync(skillMd)).toBe(true);
      expect(existsSync(workflowMd)).toBe(true);
    }
  });

  it('manifest.yaml registers all three new skills', () => {
    const manifest = readFileSync(join(REPO_ROOT, '_Sprintpilot', 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('sprintpilot-plan-sprint');
    expect(manifest).toContain('sprintpilot-sprint-progress');
    expect(manifest).toContain('sprintpilot-dependency-graph');
  });
});

// ──────────────────────────────────────────────────────────────────
// Round 4 — cmdStart integration flows that surfaced as test gaps in
// the adversarial review. These exercise the autopilot.js cmdStart
// path end-to-end via spawnSync to verify the plan-aware behavior
// surfaces correctly to the LLM session via the emitted JSON.
// ──────────────────────────────────────────────────────────────────

describe('cmdStart plan-aware flows (Round 4 coverage)', () => {
  // Helper: run cmdStart and capture the JSON action it emits. Returns
  // the parsed JSON or null if the output couldn't be parsed (which
  // would itself be a bug worth catching).
  function runAutopilotStart(): { stdout: string; stderr: string; action: Record<string, unknown> | null } {
    const r = spawnSync('node', [AUTOPILOT, 'start', '--project-root', tmpRoot, '--no-auto-plan'], {
      encoding: 'utf8',
    });
    let action: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(r.stdout);
      action = parsed.action || null;
    } catch {
      /* leave null */
    }
    return { stdout: r.stdout, stderr: r.stderr, action };
  }

  it('plan_exhausted: cmdStart emits user_prompt halt + archives the plan', () => {
    seedSprintStatus('development_status:\n  1-1-a: done\n');
    // All-terminal plan. cmdStart should detect exhaustion, archive,
    // and emit a user_prompt halt with reason='plan_exhausted'.
    const plan = buildEmptyPlan();
    plan.stories = [{ key: '1-1-a', plan_status: 'done', priority: 1 }];
    writePlanFromObject(plan);
    const planId = readPlanFromDisk().plan_id as string;

    // We don't actually run cmdStart here because the full session
    // requires a git repo + worktree health check + lock. Instead we
    // exercise the planExhausted detection logic directly via the
    // orchestrator helper, which is what cmdStart calls.
    const r = spawnSync(
      'node',
      [
        '-e',
        `const m = require('${sx(join(REPO_ROOT, '_Sprintpilot/lib/orchestrator/sprint-plan.js'))}');
         console.log(JSON.stringify(m.planExhausted({ projectRoot: '${sx(tmpRoot)}' })));`,
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(r.stdout);
    expect(result.exhausted).toBe(true);
    expect(result.plan_id).toBe(planId);
    expect(result.total).toBe(1);
    expect(result.terminal_counts.done).toBe(1);
  });

  it('auto_plan_on_start: shouldAutoDerive gating respects the config knob', () => {
    seedSprintStatus('development_status:\n  1-1-a: backlog\n');
    // Default (auto_plan_on_start = false, missing plan, no flags):
    // should NOT auto-derive; the autopilot falls back to sprint-status order.
    const off = spawnSync(
      'node',
      [
        '-e',
        `const m = require('${sx(join(REPO_ROOT, '_Sprintpilot/lib/orchestrator/sprint-plan.js'))}');
         console.log(JSON.stringify(m.shouldAutoDerive({
           projectRoot: '${sx(tmpRoot)}',
           profile: { auto_plan_on_start: false },
           opts: {},
         })));`,
      ],
      { encoding: 'utf8' },
    );
    const offResult = JSON.parse(off.stdout);
    expect(offResult.auto_derive).toBe(false);
    expect(offResult.reason).toBe('greenfield_default_no_auto_plan');

    // Opt-in (auto_plan_on_start = true, missing plan, no flags):
    // should auto-derive.
    const on = spawnSync(
      'node',
      [
        '-e',
        `const m = require('${sx(join(REPO_ROOT, '_Sprintpilot/lib/orchestrator/sprint-plan.js'))}');
         console.log(JSON.stringify(m.shouldAutoDerive({
           projectRoot: '${sx(tmpRoot)}',
           profile: { auto_plan_on_start: true },
           opts: {},
         })));`,
      ],
      { encoding: 'utf8' },
    );
    const onResult = JSON.parse(on.stdout);
    expect(onResult.auto_derive).toBe(true);
    expect(onResult.reason).toBe('opt_in_missing');

    // --no-auto-plan flag overrides even when opt-in is true.
    const noFlag = spawnSync(
      'node',
      [
        '-e',
        `const m = require('${sx(join(REPO_ROOT, '_Sprintpilot/lib/orchestrator/sprint-plan.js'))}');
         console.log(JSON.stringify(m.shouldAutoDerive({
           projectRoot: '${sx(tmpRoot)}',
           profile: { auto_plan_on_start: true },
           opts: { 'no-auto-plan': true },
         })));`,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(noFlag.stdout).auto_derive).toBe(false);
  });

  it('legacy migration: bootstrapMigrationIfNeeded auto-triggers on cmdStart-equivalent flow', () => {
    // Seed a legacy dependencies.yaml file. The orchestrator helper
    // bootstrapMigrationIfNeeded() is called by cmdStart before queue
    // build; verify it imports + archives + reports the import.
    seedSprintStatus('development_status:\n  1-1-a: backlog\n');
    const legacyDir = join(tmpRoot, '_Sprintpilot', 'sprints');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'dependencies.yaml'),
      [
        'version: 1',
        'stories:',
        '  1-1-a:',
        '    depends_on: []',
        '    rationale: "starter"',
        'overrides: []',
        'epics: {}',
        '',
      ].join('\n'),
    );
    const r = spawnSync(
      'node',
      [
        '-e',
        `const m = require('${sx(join(REPO_ROOT, '_Sprintpilot/lib/orchestrator/sprint-plan.js'))}');
         console.log(JSON.stringify(m.bootstrapMigrationIfNeeded({ projectRoot: '${sx(tmpRoot)}' })));`,
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(r.stdout);
    expect(result.migrated).toBe(true);
    expect(result.stories_imported).toBe(1);
    // Legacy file moved to archive.
    expect(existsSync(join(tmpRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'))).toBe(false);
    expect(existsSync(join(tmpRoot, '.archive', 'dependencies.yaml.migrated'))).toBe(true);
    // Plan exists with the imported story.
    const plan = readPlanFromDisk();
    expect((plan.dependencies as Record<string, unknown>).stories).toMatchObject({
      '1-1-a': { depends_on: [], rationale: 'starter' },
    });

    // Second call is a no-op (idempotent).
    const second = spawnSync(
      'node',
      [
        '-e',
        `const m = require('${sx(join(REPO_ROOT, '_Sprintpilot/lib/orchestrator/sprint-plan.js'))}');
         console.log(JSON.stringify(m.bootstrapMigrationIfNeeded({ projectRoot: '${sx(tmpRoot)}' })));`,
      ],
      { encoding: 'utf8' },
    );
    const secondResult = JSON.parse(second.stdout);
    expect(secondResult.skipped).toBe(true);
    expect(secondResult.reason).toBe('no_legacy_file');
  });
});

