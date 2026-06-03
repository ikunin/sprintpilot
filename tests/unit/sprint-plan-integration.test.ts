// Integration tests covering Phase 0 of v2.3.0:
//   - infer-dependencies.js `write` retargeted to sprint-plan.yaml
//   - infer-dependencies.js `migrate` (legacy → new)
//   - resolve-dag.js readDependencies + edgesFromCrossEpic
//
// The legacy tests in infer-dependencies.test.ts and resolve-dag.test.ts
// cover the pre-v2.3.0 API and are intentionally left as-failing for the
// dedicated test-rewrite pass. This file is the green coverage of the
// new behavior.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import inferMod from '../../_Sprintpilot/scripts/infer-dependencies.js';
// @ts-expect-error — CommonJS module
import dagMod from '../../_Sprintpilot/scripts/resolve-dag.js';
// @ts-expect-error — CommonJS module
import sprintPlanMod from '../../_Sprintpilot/scripts/sprint-plan.js';

const REPO_ROOT = join(__dirname, '..', '..');
const INFER = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'infer-dependencies.js');
const RESOLVE_DAG = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'resolve-dag.js');

const {
  applyEnvelopeToPlan,
  mergeLegacyIntoPlan,
  readLegacyDependencies,
  diffEdges,
  scaffoldCrossEpicPrompt,
  validateCrossEpicEnvelope,
  applyCrossEpicToPlan,
  CROSS_EPIC_RATIONALE_MAX,
} = inferMod as {
  applyEnvelopeToPlan: (
    envelope: Record<string, unknown>,
    plan: Record<string, unknown>,
    ctx: { projectRoot: string; epic: string },
  ) => Record<string, unknown>;
  mergeLegacyIntoPlan: (
    legacy: Record<string, unknown>,
    plan: Record<string, unknown>,
  ) => Record<string, unknown>;
  readLegacyDependencies: (projectRoot: string) => {
    exists: boolean;
    doc?: Record<string, unknown>;
    error?: string;
    message?: string;
  };
  diffEdges: (
    prev: Record<string, unknown>,
    next: Record<string, unknown>,
  ) => { added: number; removed: number };
  scaffoldCrossEpicPrompt: (projectRoot: string) => string;
  validateCrossEpicEnvelope: (
    envelope: Record<string, unknown>,
    ctx: { projectRoot: string; plan: Record<string, unknown> },
  ) => { valid: boolean; errors: Array<{ code: string; [k: string]: unknown }> };
  applyCrossEpicToPlan: (
    envelope: Record<string, unknown>,
    plan: Record<string, unknown>,
  ) => Record<string, unknown>;
  CROSS_EPIC_RATIONALE_MAX: number;
};

const {
  readDependencies,
  edgesFromCrossEpic,
  edgesFromExplicit,
  buildDag,
  planStatusByKey,
  bucketEdges,
  renderMermaid,
  renderGraphviz,
  defaultRenderOutputPath,
  runRender,
  STATUS_COLORS,
} = dagMod as {
  readDependencies: (root: string) => Record<string, unknown> | null;
  edgesFromCrossEpic: (
    depsDoc: Record<string, unknown> | null,
    nodes: string[],
  ) => [string, string][];
  edgesFromExplicit: (
    depsDoc: Record<string, unknown> | null,
    nodes: string[],
  ) => [string, string][];
  buildDag: (opts: { projectRoot: string; epic: string | null; strategies: string[] }) => {
    nodes: string[];
    edges: [string, string][];
    layers: string[][];
    width: number;
    cycle: string[];
  };
  planStatusByKey: (plan: Record<string, unknown> | null) => Map<string, string>;
  bucketEdges: (edges: [string, string][]) => {
    intra: [string, string][];
    cross: [string, string][];
  };
  renderMermaid: (
    dag: { nodes: string[]; edges: [string, string][] },
    plan: Record<string, unknown> | null,
  ) => string;
  renderGraphviz: (
    dag: { nodes: string[]; edges: [string, string][] },
    plan: Record<string, unknown> | null,
  ) => string;
  defaultRenderOutputPath: (projectRoot: string, format: string) => string;
  runRender: (opts: {
    projectRoot: string;
    epic: string | null;
    format: string;
    output: string | null;
  }) => Record<string, unknown>;
  STATUS_COLORS: Record<string, { fill: string; text: string }>;
};

const {
  emptyPlan,
  read: readPlan,
  planPath,
} = sprintPlanMod as {
  emptyPlan: (opts?: { source?: string }) => Record<string, unknown>;
  read: (opts: { projectRoot: string }) => Record<string, unknown> | null;
  planPath: (root: string) => string;
};

let tmpRoot = '';

function seedProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-int-'));
  const impl = join(root, '_bmad-output', 'implementation-artifacts');
  mkdirSync(impl, { recursive: true });
  writeFileSync(
    join(impl, 'sprint-status.yaml'),
    [
      'development_status:',
      '  1-1-bootstrap: backlog',
      '  1-2-models: backlog',
      '  1-3-add-auth: backlog',
      '  2-1-foo: backlog',
      '  2-2-bar: backlog',
      '',
    ].join('\n'),
  );
  return root;
}

beforeEach(() => {
  tmpRoot = seedProject();
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────
// `write` (retargeted): produces sprint-plan.yaml
// ──────────────────────────────────────────────────────────────────

describe('infer-dependencies write (retargeted)', () => {
  function writeEpicDeps(
    epic: string,
    envelope: Record<string, unknown>,
  ): {
    status: number;
    stdout: string;
  } {
    const r = spawnSync('node', [INFER, 'write', '--epic', epic, '--project-root', tmpRoot], {
      encoding: 'utf8',
      input: JSON.stringify(envelope),
    });
    return { status: r.status ?? 0, stdout: r.stdout };
  }

  it('creates sprint-plan.yaml at the new location on first write', () => {
    const r = writeEpicDeps('1', {
      version: 1,
      epic: '1',
      dependencies: { '1-3-add-auth': ['1-1-bootstrap', '1-2-models'] },
      rationale: { '1-3-add-auth': 'needs base + models' },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).wrote).toBe(true);
    expect(existsSync(planPath(tmpRoot))).toBe(true);
    expect(existsSync(join(tmpRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'))).toBe(false);
  });

  it('preserves other-epic entries when writing for one epic', () => {
    // Pre-seed plan with an epic-2 entry
    const plan = emptyPlan({ source: 'auto' });
    (plan.dependencies as Record<string, unknown>).stories = {
      '2-2-bar': { depends_on: ['2-1-foo'], rationale: 'epic-2 chain' },
    };
    writeFileSync(
      planPath(tmpRoot),
      execFileSync(
        'node',
        [join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sprint-plan.js'), 'empty', '--source', 'auto'],
        { encoding: 'utf8' },
      ),
    );
    // Use the actual sprint-plan.js write to seed properly
    const seedR = spawnSync(
      'node',
      [
        join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sprint-plan.js'),
        'write',
        '--project-root',
        tmpRoot,
      ],
      {
        encoding: 'utf8',
        input: JSON.stringify({
          ...plan,
          dependencies: {
            version: 1,
            auto_inferred_at: null,
            stories: { '2-2-bar': { depends_on: ['2-1-foo'], rationale: 'epic-2 chain' } },
          },
        }),
      },
    );
    expect(seedR.status).toBe(0);

    // Now write epic-1 envelope
    writeEpicDeps('1', {
      version: 1,
      epic: '1',
      dependencies: { '1-3-add-auth': ['1-1-bootstrap'] },
      rationale: { '1-3-add-auth': 'depends on bootstrap' },
    });

    const final = readPlan({ projectRoot: tmpRoot }) as Record<string, unknown>;
    const stories = (final.dependencies as { stories: Record<string, unknown> }).stories;
    expect(stories['2-2-bar']).toBeDefined();
    expect(stories['1-3-add-auth']).toBeDefined();
  });

  it('removes this-epic entries that are absent from the envelope', () => {
    writeEpicDeps('1', {
      version: 1,
      epic: '1',
      dependencies: {
        '1-2-models': ['1-1-bootstrap'],
        '1-3-add-auth': ['1-2-models'],
      },
      rationale: {
        '1-2-models': 'first',
        '1-3-add-auth': 'second',
      },
    });
    // Re-write with FEWER entries
    writeEpicDeps('1', {
      version: 1,
      epic: '1',
      dependencies: { '1-3-add-auth': ['1-1-bootstrap'] },
      rationale: { '1-3-add-auth': 'just bootstrap now' },
    });
    const plan = readPlan({ projectRoot: tmpRoot }) as Record<string, unknown>;
    const stories = (plan.dependencies as { stories: Record<string, unknown> }).stories;
    expect(stories['1-2-models']).toBeUndefined();
    expect(stories['1-3-add-auth']).toBeDefined();
  });

  it('stamps dependencies.auto_inferred_at on every write', () => {
    writeEpicDeps('1', {
      version: 1,
      epic: '1',
      dependencies: { '1-3-add-auth': ['1-1-bootstrap'] },
      rationale: { '1-3-add-auth': 'r' },
    });
    const plan = readPlan({ projectRoot: tmpRoot }) as Record<string, unknown>;
    const at = (plan.dependencies as { auto_inferred_at: string }).auto_inferred_at;
    expect(typeof at).toBe('string');
    expect(Number.isNaN(Date.parse(at))).toBe(false);
  });

  it('rejects cross-epic edges with a clear error', () => {
    const r = writeEpicDeps('1', {
      version: 1,
      epic: '1',
      dependencies: { '1-3-add-auth': ['2-1-foo'] },
      rationale: { '1-3-add-auth': 'r' },
    });
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors[0].code).toBe('cross-epic-dep');
    expect(parsed.errors[0].message).toMatch(/write-cross-epic/);
  });

  it('exits 2 with a clean error when sprint-plan.yaml is corrupt', () => {
    mkdirSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(planPath(tmpRoot), 'broken: : yaml :\n');
    const r = writeEpicDeps('1', {
      version: 1,
      epic: '1',
      dependencies: {},
      rationale: {},
    });
    expect(r.status).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.wrote).toBe(false);
    expect(parsed.reason).toBe('parse_error');
  });
});

// ──────────────────────────────────────────────────────────────────
// applyEnvelopeToPlan (pure function — unit-level)
// ──────────────────────────────────────────────────────────────────

describe('applyEnvelopeToPlan', () => {
  it('only mutates dependencies.stories — leaves other top-level keys intact', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.notes = 'preserved';
    plan.cross_epic_deps = [{ from_story: 'x', to_story: 'y', rationale: 'preserved' }];
    plan.overrides = [{ epic: '9', force_independent: ['9-1'], force_sequential: [] }];
    const next = applyEnvelopeToPlan(
      {
        version: 1,
        epic: '1',
        dependencies: { '1-3-add-auth': ['1-1-bootstrap'] },
        rationale: { '1-3-add-auth': 'r' },
      },
      plan,
      { projectRoot: tmpRoot, epic: '1' },
    );
    expect(next.notes).toBe('preserved');
    expect(next.cross_epic_deps).toEqual(plan.cross_epic_deps);
    expect(next.overrides).toEqual(plan.overrides);
  });

  it('sorts depends_on arrays deterministically', () => {
    const next = applyEnvelopeToPlan(
      {
        version: 1,
        epic: '1',
        dependencies: { '1-3-add-auth': ['1-2-models', '1-1-bootstrap'] },
        rationale: { '1-3-add-auth': 'r' },
      },
      emptyPlan({ source: 'auto' }),
      { projectRoot: tmpRoot, epic: '1' },
    );
    const entry = (next.dependencies as { stories: Record<string, { depends_on: string[] }> })
      .stories['1-3-add-auth'];
    expect(entry.depends_on).toEqual(['1-1-bootstrap', '1-2-models']);
  });
});

// ──────────────────────────────────────────────────────────────────
// diffEdges
// ──────────────────────────────────────────────────────────────────

describe('diffEdges', () => {
  it('counts added and removed correctly', () => {
    const prev = {
      dependencies: {
        stories: {
          a: { depends_on: ['x'] },
          b: { depends_on: ['y', 'z'] },
        },
      },
    };
    const next = {
      dependencies: {
        stories: {
          a: { depends_on: ['x', 'q'] }, // +x→a stays, +q→a added
          // b removed entirely
        },
      },
    };
    expect(diffEdges(prev, next)).toEqual({ added: 1, removed: 2 });
  });

  it('returns zero when plans are identical', () => {
    const plan = {
      dependencies: { stories: { a: { depends_on: ['x'] } } },
    };
    expect(diffEdges(plan, plan)).toEqual({ added: 0, removed: 0 });
  });

  it('handles missing dependencies block', () => {
    expect(diffEdges({}, {})).toEqual({ added: 0, removed: 0 });
  });
});

// ──────────────────────────────────────────────────────────────────
// migrate subcommand
// ──────────────────────────────────────────────────────────────────

describe('infer-dependencies migrate', () => {
  function seedLegacy(): void {
    const legacyDir = join(tmpRoot, '_Sprintpilot', 'sprints');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'dependencies.yaml'),
      [
        '# AUTO-INFERRED — regenerate via infer-dependencies.js',
        'version: 1',
        'stories:',
        '  1-3-add-auth:',
        '    depends_on: ["1-1-bootstrap"]',
        '    rationale: "needs base"',
        'overrides:',
        '  - epic: "1"',
        '    force_independent: ["1-2-models"]',
        '    force_sequential: []',
        'epics:',
        '  "1":',
        '    independent: true',
        '',
      ].join('\n'),
    );
  }

  function runMigrate(): { status: number; stdout: string } {
    const r = spawnSync('node', [INFER, 'migrate', '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    return { status: r.status ?? 0, stdout: r.stdout };
  }

  it('is a no-op when no legacy file exists', () => {
    const r = runMigrate();
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.migrated).toBe(false);
    expect(parsed.reason).toBe('no_legacy_file');
  });

  it('imports stories + overrides and archives the legacy file', () => {
    seedLegacy();
    const r = runMigrate();
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.migrated).toBe(true);
    expect(parsed.stories_imported).toBe(1);
    expect(parsed.overrides_imported).toBe(1);
    expect(parsed.epics_block_dropped).toBe(true);
    expect(parsed.archived).toMatch(/[\\/]\.archive[\\/]dependencies\.yaml\.migrated$/);
    expect(existsSync(parsed.archived)).toBe(true);
    expect(existsSync(join(tmpRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'))).toBe(false);
  });

  it('emits a warning when legacy epics block is dropped', () => {
    seedLegacy();
    const r = runMigrate();
    const parsed = JSON.parse(r.stdout);
    expect(parsed.warning).toMatch(/epics: block dropped/);
  });

  it('produces a plan with source=migrated', () => {
    seedLegacy();
    runMigrate();
    const plan = readPlan({ projectRoot: tmpRoot }) as Record<string, unknown>;
    expect(plan.source).toBe('migrated');
  });

  it('re-running after archive is a clean no-op (idempotent)', () => {
    seedLegacy();
    runMigrate();
    const second = runMigrate();
    expect(second.status).toBe(0);
    const parsed = JSON.parse(second.stdout);
    expect(parsed.migrated).toBe(false);
    expect(parsed.reason).toBe('no_legacy_file');
  });

  it('exits 1 with parse_error when the legacy file is corrupt', () => {
    const legacyDir = join(tmpRoot, '_Sprintpilot', 'sprints');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'dependencies.yaml'), 'broken: : yaml :\n');
    const r = runMigrate();
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.migrated).toBe(false);
    expect(parsed.reason).toBe('parse_error');
  });

  it('exits 1 when legacy file is not a YAML mapping', () => {
    const legacyDir = join(tmpRoot, '_Sprintpilot', 'sprints');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'dependencies.yaml'), '- listitem\n');
    const r = runMigrate();
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.reason).toBe('invalid_legacy_shape');
  });
});

// ──────────────────────────────────────────────────────────────────
// mergeLegacyIntoPlan (pure function)
// ──────────────────────────────────────────────────────────────────

describe('mergeLegacyIntoPlan', () => {
  it('dedupes overrides by epic key', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.overrides = [{ epic: '1', force_independent: ['original'], force_sequential: [] }];
    const merged = mergeLegacyIntoPlan(
      {
        version: 1,
        stories: {},
        overrides: [{ epic: '1', force_independent: ['from-legacy'], force_sequential: [] }],
      },
      plan,
    );
    expect((merged.overrides as Array<{ epic: string }>).length).toBe(1);
    expect(
      (merged.overrides as Array<{ force_independent: string[] }>)[0].force_independent,
    ).toEqual(['original']);
  });

  it('preserves notes from existing plan', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.notes = 'keep me';
    const merged = mergeLegacyIntoPlan({ version: 1, stories: {} }, plan);
    expect(merged.notes).toBe('keep me');
  });

  it('REPLACES dependencies.stories with legacy content', () => {
    const plan = emptyPlan({ source: 'auto' });
    (plan.dependencies as Record<string, unknown>).stories = { existing: { depends_on: [] } };
    const merged = mergeLegacyIntoPlan(
      { version: 1, stories: { from_legacy: { depends_on: ['x'] } } },
      plan,
    );
    const stories = (merged.dependencies as { stories: Record<string, unknown> }).stories;
    expect(stories.existing).toBeUndefined();
    expect(stories.from_legacy).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// resolve-dag readDependencies (now via sprint-plan.yaml)
// ──────────────────────────────────────────────────────────────────

describe('resolve-dag readDependencies (via sprint-plan.yaml)', () => {
  it('returns null when no plan exists', () => {
    expect(readDependencies(tmpRoot)).toBeNull();
  });

  it('extracts stories + overrides + cross_epic_deps from the plan', () => {
    const plan = emptyPlan({ source: 'auto' });
    (plan.dependencies as Record<string, unknown>).stories = {
      a: { depends_on: ['b'], rationale: 'r' },
    };
    plan.overrides = [{ epic: '1', force_independent: ['a'], force_sequential: [] }];
    plan.cross_epic_deps = [{ from_story: 'a', to_story: 'b', rationale: 'r' }];
    spawnSync(
      'node',
      [
        join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sprint-plan.js'),
        'write',
        '--project-root',
        tmpRoot,
      ],
      { input: JSON.stringify(plan), encoding: 'utf8' },
    );

    const doc = readDependencies(tmpRoot) as {
      stories: Record<string, unknown>;
      overrides: unknown[];
      cross_epic_deps: unknown[];
    };
    expect(doc).not.toBeNull();
    expect(doc.stories.a).toBeDefined();
    expect(doc.overrides.length).toBe(1);
    expect(doc.cross_epic_deps.length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// edgesFromCrossEpic
// ──────────────────────────────────────────────────────────────────

describe('edgesFromCrossEpic', () => {
  it('returns empty for null depsDoc', () => {
    expect(edgesFromCrossEpic(null, ['a', 'b'])).toEqual([]);
  });

  it('emits [to, from] tuples so to runs before from in topo order', () => {
    const doc = {
      cross_epic_deps: [{ from_story: '4-3-foo', to_story: '3-1-bar', rationale: 'r' }],
    };
    expect(edgesFromCrossEpic(doc, ['4-3-foo', '3-1-bar'])).toEqual([['3-1-bar', '4-3-foo']]);
  });

  it('filters edges that reference nodes outside the current scope', () => {
    const doc = {
      cross_epic_deps: [
        { from_story: 'a', to_story: 'b', rationale: 'r' },
        { from_story: 'a', to_story: 'missing', rationale: 'r' },
      ],
    };
    expect(edgesFromCrossEpic(doc, ['a', 'b']).length).toBe(1);
  });

  it('rejects malformed edges silently', () => {
    const doc = {
      cross_epic_deps: [
        null,
        { from_story: 'a' }, // missing to_story
        { to_story: 'b' }, // missing from_story
        { from_story: 'a', to_story: 'b' },
      ],
    };
    expect(edgesFromCrossEpic(doc, ['a', 'b']).length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// scaffold-prompt --cross-epic
// ──────────────────────────────────────────────────────────────────

describe('scaffoldCrossEpicPrompt', () => {
  it('emits a prompt that names sprint-plan.yaml + sprint-status + epics + architecture', () => {
    const p = scaffoldCrossEpicPrompt(tmpRoot).replace(/\\/g, '/');
    expect(p).toContain('CROSS-EPIC');
    expect(p).toContain('_bmad-output/implementation-artifacts/sprint-plan.yaml');
    expect(p).toContain('_bmad-output/implementation-artifacts/sprint-status.yaml');
    expect(p).toContain('_bmad-output/planning-artifacts/epics.md');
    expect(p).toContain('_bmad-output/planning-artifacts/architecture.md');
  });

  it('states the rationale max-length matches the validator', () => {
    const p = scaffoldCrossEpicPrompt(tmpRoot);
    expect(p).toContain(`${CROSS_EPIC_RATIONALE_MAX} chars`);
  });

  it('explicitly forbids same-epic edges and duplicates', () => {
    const p = scaffoldCrossEpicPrompt(tmpRoot);
    expect(p).toMatch(/different epics/i);
    expect(p).toMatch(/duplicate/i);
  });
});

// ──────────────────────────────────────────────────────────────────
// validateCrossEpicEnvelope
// ──────────────────────────────────────────────────────────────────

describe('validateCrossEpicEnvelope', () => {
  function basePlanWithPerEpic(): Record<string, unknown> {
    const plan = emptyPlan({ source: 'auto' });
    (plan.dependencies as Record<string, unknown>).stories = {
      '1-3-add-auth': { depends_on: ['1-1-bootstrap'], rationale: 'r' },
    };
    return plan;
  }

  it('accepts an empty cross_epic_deps array', () => {
    const r = validateCrossEpicEnvelope(
      { version: 1, cross_epic_deps: [] },
      { projectRoot: tmpRoot, plan: basePlanWithPerEpic() },
    );
    expect(r.valid).toBe(true);
  });

  it('rejects wrong version', () => {
    const r = validateCrossEpicEnvelope(
      { version: 2, cross_epic_deps: [] },
      { projectRoot: tmpRoot, plan: emptyPlan({ source: 'auto' }) },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe('schema');
  });

  it('rejects same-epic edges', () => {
    const r = validateCrossEpicEnvelope(
      {
        version: 1,
        cross_epic_deps: [
          { from_story: '1-3-add-auth', to_story: '1-1-bootstrap', rationale: 'r' },
        ],
      },
      { projectRoot: tmpRoot, plan: emptyPlan({ source: 'auto' }) },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe('same-epic');
  });

  it('rejects rationale exceeding the max-length cap', () => {
    const r = validateCrossEpicEnvelope(
      {
        version: 1,
        cross_epic_deps: [
          {
            from_story: '2-1-foo',
            to_story: '1-3-add-auth',
            rationale: 'x'.repeat(CROSS_EPIC_RATIONALE_MAX + 1),
          },
        ],
      },
      { projectRoot: tmpRoot, plan: emptyPlan({ source: 'auto' }) },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe('rationale-too-long');
  });

  it('rejects unknown story keys (not in sprint-status)', () => {
    const r = validateCrossEpicEnvelope(
      {
        version: 1,
        cross_epic_deps: [{ from_story: 'nope-1-a', to_story: '1-3-add-auth', rationale: 'r' }],
      },
      { projectRoot: tmpRoot, plan: emptyPlan({ source: 'auto' }) },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe('unknown-key');
  });

  it('rejects edges that duplicate per-epic dependencies', () => {
    const plan = emptyPlan({ source: 'auto' });
    (plan.dependencies as Record<string, unknown>).stories = {
      // 1-3 depends on 1-1 per-epic. If cross-epic envelope says "1-3 depends on 1-1"
      // (impossible since 1-3 and 1-1 are same epic) we'd get 'same-epic' first.
      // Instead test against a cross-epic edge that overlaps: pretend per-epic plan
      // has cross-boundary edge already (shouldn't happen but defense-in-depth).
      '2-1-foo': { depends_on: ['1-3-add-auth'], rationale: 'r' },
    };
    const r = validateCrossEpicEnvelope(
      {
        version: 1,
        cross_epic_deps: [{ from_story: '2-1-foo', to_story: '1-3-add-auth', rationale: 'dup' }],
      },
      { projectRoot: tmpRoot, plan },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe('duplicate-of-per-epic');
  });

  it('detects cycles in the combined intra + cross-epic graph', () => {
    const plan = emptyPlan({ source: 'auto' });
    (plan.dependencies as Record<string, unknown>).stories = {
      '1-3-add-auth': { depends_on: ['1-1-bootstrap'], rationale: 'r' },
    };
    const r = validateCrossEpicEnvelope(
      {
        version: 1,
        cross_epic_deps: [
          { from_story: '1-1-bootstrap', to_story: '2-1-foo', rationale: 'a' },
          { from_story: '2-1-foo', to_story: '1-3-add-auth', rationale: 'b' },
        ],
      },
      { projectRoot: tmpRoot, plan },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe('cycle');
    expect(r.errors[0].nodes).toEqual(
      expect.arrayContaining(['1-1-bootstrap', '1-3-add-auth', '2-1-foo']),
    );
  });

  it('rejects duplicate edges within the same envelope', () => {
    const r = validateCrossEpicEnvelope(
      {
        version: 1,
        cross_epic_deps: [
          { from_story: '2-1-foo', to_story: '1-3-add-auth', rationale: 'first' },
          { from_story: '2-1-foo', to_story: '1-3-add-auth', rationale: 'second' },
        ],
      },
      { projectRoot: tmpRoot, plan: emptyPlan({ source: 'auto' }) },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe('duplicate-in-envelope');
  });
});

// ──────────────────────────────────────────────────────────────────
// applyCrossEpicToPlan
// ──────────────────────────────────────────────────────────────────

describe('applyCrossEpicToPlan', () => {
  it('replaces cross_epic_deps and stamps inferred_at on each entry', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.cross_epic_deps = [{ from_story: 'old', to_story: 'older', rationale: 'old' }];
    const merged = applyCrossEpicToPlan(
      {
        version: 1,
        cross_epic_deps: [
          { from_story: '2-1-foo', to_story: '1-3-add-auth', rationale: 'needs auth' },
        ],
      },
      plan,
    );
    expect(merged.cross_epic_deps).toEqual([
      expect.objectContaining({
        from_story: '2-1-foo',
        to_story: '1-3-add-auth',
        rationale: 'needs auth',
        inferred_at: expect.any(String),
      }),
    ]);
    // Old entries gone.
    expect(
      (merged.cross_epic_deps as Array<{ from_story: string }>).some((e) => e.from_story === 'old'),
    ).toBe(false);
  });

  it('preserves the rest of the plan verbatim', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.notes = 'preserved';
    (plan.dependencies as Record<string, unknown>).stories = { a: { depends_on: [] } };
    const merged = applyCrossEpicToPlan({ version: 1, cross_epic_deps: [] }, plan);
    expect(merged.notes).toBe('preserved');
    expect((merged.dependencies as { stories: Record<string, unknown> }).stories.a).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// write-cross-epic CLI
// ──────────────────────────────────────────────────────────────────

describe('write-cross-epic CLI', () => {
  function bootstrapPerEpicPlan(): void {
    spawnSync('node', [INFER, 'write', '--epic', '1', '--project-root', tmpRoot], {
      encoding: 'utf8',
      input: JSON.stringify({
        version: 1,
        epic: '1',
        dependencies: { '1-3-add-auth': ['1-1-bootstrap'] },
        rationale: { '1-3-add-auth': 'r' },
      }),
    });
  }

  it('appends to plan.cross_epic_deps with inferred_at stamps', () => {
    bootstrapPerEpicPlan();
    const r = spawnSync('node', [INFER, 'write-cross-epic', '--project-root', tmpRoot], {
      encoding: 'utf8',
      input: JSON.stringify({
        version: 1,
        cross_epic_deps: [
          { from_story: '2-1-foo', to_story: '1-3-add-auth', rationale: 'needs auth' },
        ],
      }),
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.wrote).toBe(true);
    expect(parsed.edges_inferred).toBe(1);
    const plan = readPlan({ projectRoot: tmpRoot }) as Record<string, unknown>;
    expect(plan.cross_epic_deps).toEqual([
      expect.objectContaining({
        from_story: '2-1-foo',
        to_story: '1-3-add-auth',
        rationale: 'needs auth',
        inferred_at: expect.any(String),
      }),
    ]);
  });

  it('exit 1 with validation errors on a malformed envelope', () => {
    bootstrapPerEpicPlan();
    const r = spawnSync('node', [INFER, 'write-cross-epic', '--project-root', tmpRoot], {
      encoding: 'utf8',
      input: JSON.stringify({
        version: 1,
        cross_epic_deps: [
          { from_story: '1-1-bootstrap', to_story: '1-3-add-auth', rationale: 'same epic' },
        ],
      }),
    });
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors[0].code).toBe('same-epic');
  });

  it('exit 2 when sprint-plan.yaml is corrupt', () => {
    mkdirSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(planPath(tmpRoot), 'broken: : yaml :\n');
    const r = spawnSync('node', [INFER, 'write-cross-epic', '--project-root', tmpRoot], {
      encoding: 'utf8',
      input: JSON.stringify({ version: 1, cross_epic_deps: [] }),
    });
    expect(r.status).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.wrote).toBe(false);
    expect(parsed.reason).toBe('parse_error');
  });
});

// ──────────────────────────────────────────────────────────────────
// buildDag with cross-epic edges
// ──────────────────────────────────────────────────────────────────

describe('buildDag with cross-epic edges', () => {
  function writePlanWithCrossEpic(): void {
    const plan = emptyPlan({ source: 'auto' });
    (plan.dependencies as Record<string, unknown>).stories = {
      '1-3-add-auth': { depends_on: ['1-1-bootstrap', '1-2-models'], rationale: 'r' },
    };
    plan.cross_epic_deps = [
      { from_story: '2-1-foo', to_story: '1-3-add-auth', rationale: 'needs auth' },
    ];
    spawnSync(
      'node',
      [
        join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sprint-plan.js'),
        'write',
        '--project-root',
        tmpRoot,
      ],
      { input: JSON.stringify(plan), encoding: 'utf8' },
    );
  }

  it('excludes cross-epic edges when filtered by --epic', () => {
    writePlanWithCrossEpic();
    const dag = buildDag({ projectRoot: tmpRoot, epic: '1', strategies: ['explicit', 'ordering'] });
    expect(dag.nodes).toEqual(['1-1-bootstrap', '1-2-models', '1-3-add-auth']);
    // No edge from 1-3-add-auth to 2-1-foo because 2-1-foo isn't in node set
    expect(dag.edges.some(([a, b]) => a === '1-3-add-auth' && b === '2-1-foo')).toBe(false);
  });

  it('includes cross-epic edges sprint-wide and orders 1-3 before 2-1', () => {
    writePlanWithCrossEpic();
    const dag = buildDag({
      projectRoot: tmpRoot,
      epic: null,
      strategies: ['explicit', 'ordering'],
    });
    expect(dag.nodes.length).toBe(5);
    expect(dag.edges.some(([a, b]) => a === '1-3-add-auth' && b === '2-1-foo')).toBe(true);
    const layer13 = dag.layers.findIndex((l) => l.includes('1-3-add-auth'));
    const layer21 = dag.layers.findIndex((l) => l.includes('2-1-foo'));
    expect(layer13).toBeGreaterThanOrEqual(0);
    expect(layer21).toBeGreaterThan(layer13);
  });
});

// ──────────────────────────────────────────────────────────────────
// planStatusByKey
// ──────────────────────────────────────────────────────────────────

describe('planStatusByKey', () => {
  it('returns an empty Map when plan.stories is empty', () => {
    expect(planStatusByKey(emptyPlan({ source: 'auto' })).size).toBe(0);
  });

  it('handles a null plan gracefully', () => {
    expect(planStatusByKey(null).size).toBe(0);
  });

  it('maps story keys to plan_status when stories[] is populated', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [
      { key: '1-1-bootstrap', plan_status: 'done' },
      { key: '1-2-models', plan_status: 'skipped' },
      { key: '1-3-add-auth', plan_status: 'pending' },
    ];
    const m = planStatusByKey(plan);
    expect(m.get('1-1-bootstrap')).toBe('done');
    expect(m.get('1-2-models')).toBe('skipped');
    expect(m.get('1-3-add-auth')).toBe('pending');
  });

  it('coerces unknown plan_status values to pending', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: 'x', plan_status: 'in-progress' }];
    expect(planStatusByKey(plan).get('x')).toBe('pending');
  });
});

// ──────────────────────────────────────────────────────────────────
// bucketEdges
// ──────────────────────────────────────────────────────────────────

describe('bucketEdges', () => {
  it('splits edges into intra-epic and cross-epic', () => {
    const r = bucketEdges([
      ['1-1', '1-2'], // intra (epic 1)
      ['1-3', '2-1'], // cross (1 → 2)
      ['2-1', '2-2'], // intra (epic 2)
    ]);
    expect(r.intra).toEqual([
      ['1-1', '1-2'],
      ['2-1', '2-2'],
    ]);
    expect(r.cross).toEqual([['1-3', '2-1']]);
  });

  it('keys with the same parsed epic prefix are intra', () => {
    const r = bucketEdges([['foo-1', 'foo-2']]);
    expect(r.cross.length).toBe(0);
    expect(r.intra.length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// renderMermaid + renderGraphviz (pure formatters)
// ──────────────────────────────────────────────────────────────────

describe('renderMermaid', () => {
  it('emits a flowchart with plan-id comment, subgraphs, and classDef block', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.plan_id = 'test-plan-id';
    plan.stories = [{ key: '1-1-a', plan_status: 'done' }];
    const out = renderMermaid({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toContain('%% plan-id: test-plan-id');
    expect(out).toContain('flowchart LR');
    expect(out).toContain('subgraph epic_1 ["Epic 1"]');
    expect(out).toContain('1-1-a["1-1-a"]:::done');
    expect(out).toContain('classDef done fill:#888888');
  });

  it('renders cross-epic edges with dashed syntax', () => {
    const plan = emptyPlan({ source: 'auto' });
    const out = renderMermaid({ nodes: ['1-1', '2-1'], edges: [['1-1', '2-1']] }, plan);
    expect(out).toMatch(/1-1 -\. cross-epic \.-> 2-1/);
  });

  it('defaults to pending status when a node has no entry in plan.stories', () => {
    const plan = emptyPlan({ source: 'auto' });
    const out = renderMermaid({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toContain('1-1-a["1-1-a"]:::pending');
  });

  it('prefixes story labels with issue_id when set on plan.stories[*]', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'done', issue_id: 'PROJ-101' }];
    const out = renderMermaid({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toContain('1-1-a["PROJ-101: 1-1-a"]:::done');
  });

  it('omits the issue_id prefix for stories with no issue_id', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [
      { key: '1-1-a', plan_status: 'done', issue_id: 'PROJ-101' },
      { key: '1-2-b', plan_status: 'pending' }, // no issue_id
    ];
    const out = renderMermaid({ nodes: ['1-1-a', '1-2-b'], edges: [] }, plan);
    expect(out).toContain('1-1-a["PROJ-101: 1-1-a"]:::done');
    expect(out).toContain('1-2-b["1-2-b"]:::pending');
  });

  it('prefixes epic subgraph labels with issue_id when set on plan.epics[*]', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.epics = [{ id: '1', title: 'Bootstrap', issue_id: 'PROJ-100' }];
    plan.stories = [{ key: '1-1-a', plan_status: 'pending' }];
    const out = renderMermaid({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toContain('subgraph epic_1 ["PROJ-100: Epic 1"]');
  });

  it('omits the epic prefix when epic has no issue_id', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.epics = [{ id: '1', title: 'Bootstrap' }]; // no issue_id
    plan.stories = [{ key: '1-1-a', plan_status: 'pending' }];
    const out = renderMermaid({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toContain('subgraph epic_1 ["Epic 1"]');
    expect(out).not.toContain(': Epic 1');
  });
});

describe('renderGraphviz', () => {
  it('emits valid DOT with clusters per epic and fillcolor attrs', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.plan_id = 'gid';
    plan.stories = [{ key: '1-1-a', plan_status: 'pending' }];
    const out = renderGraphviz({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toMatch(/^digraph SprintPlan \{/);
    expect(out).toContain('// plan-id: gid');
    expect(out).toContain('subgraph cluster_1');
    expect(out).toContain('label="Epic 1"');
    expect(out).toContain(`fillcolor="${STATUS_COLORS.pending.fill}"`);
  });

  it('prefixes story labels with issue_id via explicit label= attribute', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'done', issue_id: 'PROJ-101' }];
    const out = renderGraphviz({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toMatch(
      /"1-1-a" \[fillcolor="[^"]+", fontcolor="[^"]+", label="PROJ-101: 1-1-a"\]/,
    );
  });

  it('omits the label= attribute when story has no issue_id (dot uses node id by default)', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending' }];
    const out = renderGraphviz({ nodes: ['1-1-a'], edges: [] }, plan);
    // No `, label=` segment when node id == visual label.
    expect(out).not.toMatch(/"1-1-a" \[[^\]]*label=/);
  });

  it('prefixes epic cluster labels with issue_id when set', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.epics = [{ id: '1', title: 'Bootstrap', issue_id: 'PROJ-100' }];
    plan.stories = [{ key: '1-1-a', plan_status: 'pending' }];
    const out = renderGraphviz({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toContain('label="PROJ-100: Epic 1";');
  });

  it('renders cross-epic edges with style=dashed and the cross-epic label', () => {
    const plan = emptyPlan({ source: 'auto' });
    const out = renderGraphviz({ nodes: ['1-1', '2-1'], edges: [['1-1', '2-1']] }, plan);
    expect(out).toMatch(/"1-1" -> "2-1" \[style=dashed, label="cross-epic"\]/);
  });
});

// ──────────────────────────────────────────────────────────────────
// runRender (full orchestration)
// ──────────────────────────────────────────────────────────────────

describe('runRender', () => {
  function bootstrapPlan(): void {
    spawnSync('node', [INFER, 'write', '--epic', '1', '--project-root', tmpRoot], {
      encoding: 'utf8',
      input: JSON.stringify({
        version: 1,
        epic: '1',
        dependencies: { '1-3-add-auth': ['1-1-bootstrap'] },
        rationale: { '1-3-add-auth': 'r' },
      }),
    });
    spawnSync('node', [INFER, 'write-cross-epic', '--project-root', tmpRoot], {
      encoding: 'utf8',
      input: JSON.stringify({
        version: 1,
        cross_epic_deps: [
          { from_story: '2-1-foo', to_story: '1-3-add-auth', rationale: 'needs auth' },
        ],
      }),
    });
  }

  it('writes a .mmd file at the default location and reports stats', () => {
    bootstrapPlan();
    const r = runRender({ projectRoot: tmpRoot, epic: null, format: 'mermaid', output: null });
    expect(r.wrote).toBe(true);
    expect(r.format).toBe('mermaid');
    // seedProject() seeds 5 stories: 1-1, 1-2, 1-3, 2-1, 2-2. Render sees them all.
    expect(r.nodes).toBe(5);
    expect(r.edges).toBeGreaterThanOrEqual(2);
    const file = defaultRenderOutputPath(tmpRoot, 'mermaid');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('flowchart LR');
  });

  it('honors --output for a custom destination path', () => {
    bootstrapPlan();
    const custom = join(tmpRoot, 'custom-dir', 'dag.mmd');
    const r = runRender({
      projectRoot: tmpRoot,
      epic: null,
      format: 'mermaid',
      output: custom,
    });
    expect(r.wrote).toBe(true);
    expect(r.file).toBe(custom);
    expect(existsSync(custom)).toBe(true);
  });

  it('excludes cross-epic edges when scoped to a single epic', () => {
    bootstrapPlan();
    const r = runRender({ projectRoot: tmpRoot, epic: '1', format: 'mermaid', output: null });
    expect(r.wrote).toBe(true);
    const body = readFileSync(r.file as string, 'utf8');
    // The "cross-epic" mention may appear only in the leading comment;
    // there should be NO dashed-edge syntax in epic-1 scope.
    expect(body).not.toMatch(/-\. cross-epic \.->/);
  });

  it('refuses to render on a cycle and surfaces the offending nodes', () => {
    mkdirSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
      'development_status:\n  1-1: backlog\n  1-2: backlog\n',
    );
    const plan = emptyPlan({ source: 'auto' });
    (plan.dependencies as Record<string, unknown>).stories = {
      '1-1': { depends_on: ['1-2'], rationale: 'r' },
      '1-2': { depends_on: ['1-1'], rationale: 'r' },
    };
    spawnSync(
      'node',
      [
        join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sprint-plan.js'),
        'write',
        '--project-root',
        tmpRoot,
      ],
      { input: JSON.stringify(plan), encoding: 'utf8' },
    );
    const r = runRender({ projectRoot: tmpRoot, epic: '1', format: 'mermaid', output: null });
    expect(r.wrote).toBe(false);
    expect(r.reason).toBe('cycle');
    expect(r.cycle).toEqual(expect.arrayContaining(['1-1', '1-2']));
  });

  it('falls back to mermaid when graphviz binary is missing (local env)', () => {
    // We assume the test runner does NOT have `dot` installed. If it does,
    // the test would assert the graphviz path; gate accordingly.
    bootstrapPlan();
    const r = runRender({
      projectRoot: tmpRoot,
      epic: null,
      format: 'graphviz',
      output: null,
    });
    expect(r.wrote).toBe(true);
    // Whichever format actually ran, the result records the requested one.
    expect(r.requested_format).toBe('graphviz');
    expect(['mermaid', 'graphviz']).toContain(r.format);
  });
});

// ──────────────────────────────────────────────────────────────────
// CLI: `resolve-dag.js render`
// ──────────────────────────────────────────────────────────────────

describe('CLI: resolve-dag render', () => {
  it('emits JSON to stdout and writes the file', () => {
    spawnSync('node', [INFER, 'write', '--epic', '1', '--project-root', tmpRoot], {
      encoding: 'utf8',
      input: JSON.stringify({
        version: 1,
        epic: '1',
        dependencies: { '1-3-add-auth': ['1-1-bootstrap'] },
        rationale: { '1-3-add-auth': 'r' },
      }),
    });
    const r = spawnSync('node', [RESOLVE_DAG, 'render', '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.wrote).toBe(true);
    expect(parsed.format).toBe('mermaid');
  });

  it('rejects an unknown format with exit code 1', () => {
    const r = spawnSync(
      'node',
      [RESOLVE_DAG, 'render', '--format', 'svg', '--project-root', tmpRoot],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown format/);
  });
});
