import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import sprintPlanMod from '../../_Sprintpilot/scripts/sprint-plan.js';

type PlanError = {
  error: string;
  path: string;
  message: string;
  missing_keys?: string[];
};

type ValidPlan = {
  schema_version: number;
  generated: string;
  source: string;
  plan_id: string;
  deps_inferred_at: string | null;
  status: {
    last_run_outcome: string;
    last_run_at: string;
    last_error: unknown;
  };
  issue_tracker: unknown;
  epics: unknown[];
  stories: unknown[];
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
  SCHEMA_VERSION,
  PLAN_FILE_REL,
  VALID_SOURCES,
  planPath,
  lockPath,
  emptyPlan,
  validatePlan,
  read,
  write,
} = sprintPlanMod as {
  SCHEMA_VERSION: number;
  PLAN_FILE_REL: string;
  VALID_SOURCES: string[];
  planPath: (root: string) => string;
  lockPath: (root: string) => string;
  emptyPlan: (opts?: { source?: string }) => ValidPlan;
  validatePlan: (
    plan: unknown,
  ) => null | { code: string; message: string; missing_keys?: string[] };
  read: (opts: { projectRoot: string }) => ValidPlan | PlanError | null;
  write: (plan: ValidPlan, opts: { projectRoot: string }) => string;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sprint-plan.js');

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-plan-'));
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────
// Constants + path helpers
// ──────────────────────────────────────────────────────────────────

describe('constants and path helpers', () => {
  it('SCHEMA_VERSION is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('VALID_SOURCES enumerates expected origins', () => {
    expect(VALID_SOURCES.sort()).toEqual(['auto', 'cli', 'migrated', 'skill']);
  });

  it('planPath roots at _bmad-output/implementation-artifacts', () => {
    // Normalize separators so the assertion passes on Windows (path.join
    // returns backslashes there). The semantic check is on the structure,
    // not the OS-specific separator character.
    expect(planPath('/tmp/proj').replace(/\\/g, '/')).toBe(
      '/tmp/proj/_bmad-output/implementation-artifacts/sprint-plan.yaml',
    );
  });

  it('lockPath roots at .sprintpilot/plan.lock', () => {
    expect(lockPath('/tmp/proj').replace(/\\/g, '/')).toBe('/tmp/proj/.sprintpilot/plan.lock');
  });

  it('PLAN_FILE_REL is the relative path under projectRoot', () => {
    expect(PLAN_FILE_REL.replace(/\\/g, '/')).toBe(
      '_bmad-output/implementation-artifacts/sprint-plan.yaml',
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// emptyPlan
// ──────────────────────────────────────────────────────────────────

describe('emptyPlan', () => {
  it('produces a plan that passes validatePlan', () => {
    const plan = emptyPlan({ source: 'auto' });
    expect(validatePlan(plan)).toBeNull();
  });

  it('uses default source=skill when none provided', () => {
    const plan = emptyPlan();
    expect(plan.source).toBe('skill');
  });

  it('accepts every value in VALID_SOURCES', () => {
    for (const src of VALID_SOURCES) {
      const p = emptyPlan({ source: src });
      expect(p.source).toBe(src);
    }
  });

  it('throws on an unknown source', () => {
    expect(() => emptyPlan({ source: 'bogus' })).toThrow(/invalid source/);
  });

  it('generates a unique plan_id per call', () => {
    const a = emptyPlan({ source: 'auto' });
    const b = emptyPlan({ source: 'auto' });
    expect(a.plan_id).not.toBe(b.plan_id);
    // UUID v4 shape (loose match)
    expect(a.plan_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('stamps generated and status.last_run_at to a parseable ISO timestamp', () => {
    const p = emptyPlan({ source: 'auto' });
    expect(Number.isNaN(Date.parse(p.generated))).toBe(false);
    expect(Number.isNaN(Date.parse(p.status.last_run_at))).toBe(false);
  });

  it('starts with empty collections and null lifecycle fields', () => {
    const p = emptyPlan({ source: 'auto' });
    expect(p.epics).toEqual([]);
    expect(p.stories).toEqual([]);
    expect(p.dependencies.stories).toEqual({});
    expect(p.cross_epic_deps).toEqual([]);
    expect(p.overrides).toEqual([]);
    expect(p.notes).toBe('');
    expect(p.deps_inferred_at).toBeNull();
    expect(p.status.last_error).toBeNull();
    expect(p.issue_tracker).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// validatePlan
// ──────────────────────────────────────────────────────────────────

describe('validatePlan', () => {
  it('returns null for a valid plan', () => {
    expect(validatePlan(emptyPlan({ source: 'auto' }))).toBeNull();
  });

  it('rejects null / undefined / arrays at root', () => {
    expect(validatePlan(null)?.code).toBe('invalid_root');
    expect(validatePlan(undefined)?.code).toBe('invalid_root');
    expect(validatePlan([] as unknown)?.code).toBe('invalid_root');
    expect(validatePlan('string' as unknown)?.code).toBe('invalid_root');
  });

  it('rejects missing schema_version', () => {
    const p = emptyPlan({ source: 'auto' }) as Record<string, unknown>;
    delete p.schema_version;
    expect(validatePlan(p)?.code).toBe('missing_schema_version');
  });

  it('rejects unsupported schema_version', () => {
    const p = emptyPlan({ source: 'auto' });
    (p as Record<string, unknown>).schema_version = 99;
    const err = validatePlan(p);
    expect(err?.code).toBe('unsupported_version');
    expect(err?.message).toMatch(/upgrade Sprintpilot/);
  });

  it('reports every missing top-level key', () => {
    const err = validatePlan({ schema_version: 1 });
    expect(err?.code).toBe('incomplete_schema');
    expect(err?.missing_keys).toEqual(
      expect.arrayContaining([
        'status',
        'epics',
        'stories',
        'dependencies',
        'cross_epic_deps',
        'overrides',
      ]),
    );
  });

  it('rejects status that is not a mapping', () => {
    const p = emptyPlan({ source: 'auto' }) as Record<string, unknown>;
    p.status = [];
    expect(validatePlan(p)?.code).toBe('invalid_status');
  });

  it('rejects epics that is not a list', () => {
    const p = emptyPlan({ source: 'auto' }) as Record<string, unknown>;
    p.epics = {};
    expect(validatePlan(p)?.code).toBe('invalid_epics');
  });

  it('rejects stories that is not a list', () => {
    const p = emptyPlan({ source: 'auto' }) as Record<string, unknown>;
    p.stories = {};
    expect(validatePlan(p)?.code).toBe('invalid_stories');
  });

  it('rejects dependencies that is not a mapping', () => {
    const p = emptyPlan({ source: 'auto' }) as Record<string, unknown>;
    p.dependencies = [];
    expect(validatePlan(p)?.code).toBe('invalid_dependencies');
  });

  it('rejects dependencies.stories that is not a mapping', () => {
    const p = emptyPlan({ source: 'auto' });
    (p.dependencies as Record<string, unknown>).stories = [];
    expect(validatePlan(p)?.code).toBe('invalid_dependencies_stories');
  });

  it('rejects cross_epic_deps that is not a list', () => {
    const p = emptyPlan({ source: 'auto' }) as Record<string, unknown>;
    p.cross_epic_deps = {};
    expect(validatePlan(p)?.code).toBe('invalid_cross_epic_deps');
  });

  it('rejects overrides that is not a list', () => {
    const p = emptyPlan({ source: 'auto' }) as Record<string, unknown>;
    p.overrides = {};
    expect(validatePlan(p)?.code).toBe('invalid_overrides');
  });
});

// ──────────────────────────────────────────────────────────────────
// read
// ──────────────────────────────────────────────────────────────────

describe('read', () => {
  it('returns null when the plan file does not exist', () => {
    expect(read({ projectRoot: tmpRoot })).toBeNull();
  });

  it('round-trips a written plan exactly (except generated stamp)', () => {
    const original = emptyPlan({ source: 'auto' });
    original.notes = 'hello world';
    write(original, { projectRoot: tmpRoot });
    const back = read({ projectRoot: tmpRoot }) as ValidPlan;
    expect(back).not.toBeNull();
    expect(back).not.toHaveProperty('error');
    expect(back.notes).toBe('hello world');
    expect(back.source).toBe('auto');
    expect(back.plan_id).toBe(original.plan_id);
  });

  it('returns parse_error on malformed YAML', () => {
    const file = planPath(tmpRoot);
    mkdirSync(planPath(tmpRoot).replace(/sprint-plan\.yaml$/, ''), { recursive: true });
    writeFileSync(file, 'broken: : yaml :\n');
    const result = read({ projectRoot: tmpRoot }) as PlanError;
    expect(result.error).toBe('parse_error');
    expect(result.path).toBe(file);
    expect(result.message).toMatch(/indentation|mapping/i);
  });

  it('returns missing_schema_version for a YAML mapping with no schema_version', () => {
    const file = planPath(tmpRoot);
    mkdirSync(planPath(tmpRoot).replace(/sprint-plan\.yaml$/, ''), { recursive: true });
    writeFileSync(file, 'foo: bar\n');
    const result = read({ projectRoot: tmpRoot }) as PlanError;
    expect(result.error).toBe('missing_schema_version');
  });

  it('returns unsupported_version for schema_version != 1', () => {
    const file = planPath(tmpRoot);
    mkdirSync(planPath(tmpRoot).replace(/sprint-plan\.yaml$/, ''), { recursive: true });
    writeFileSync(file, 'schema_version: 42\n');
    const result = read({ projectRoot: tmpRoot }) as PlanError;
    expect(result.error).toBe('unsupported_version');
  });

  it('returns incomplete_schema with missing_keys for a stub plan', () => {
    const file = planPath(tmpRoot);
    mkdirSync(planPath(tmpRoot).replace(/sprint-plan\.yaml$/, ''), { recursive: true });
    writeFileSync(file, 'schema_version: 1\n');
    const result = read({ projectRoot: tmpRoot }) as PlanError;
    expect(result.error).toBe('incomplete_schema');
    expect(result.missing_keys).toEqual(
      expect.arrayContaining([
        'status',
        'epics',
        'stories',
        'dependencies',
        'cross_epic_deps',
        'overrides',
      ]),
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// write
// ──────────────────────────────────────────────────────────────────

describe('write', () => {
  it('creates the file at planPath and returns the path', () => {
    const plan = emptyPlan({ source: 'auto' });
    const file = write(plan, { projectRoot: tmpRoot });
    expect(file).toBe(planPath(tmpRoot));
    expect(existsSync(file)).toBe(true);
  });

  it('creates the implementation-artifacts directory if missing', () => {
    rmSync(join(tmpRoot, '_bmad-output'), { recursive: true, force: true });
    const plan = emptyPlan({ source: 'auto' });
    write(plan, { projectRoot: tmpRoot });
    expect(existsSync(planPath(tmpRoot))).toBe(true);
  });

  it('stamps a fresh generated timestamp on every write', async () => {
    const plan = emptyPlan({ source: 'auto' });
    const original = plan.generated;
    await new Promise((r) => setTimeout(r, 10));
    write(plan, { projectRoot: tmpRoot });
    const back = read({ projectRoot: tmpRoot }) as ValidPlan;
    expect(back.generated).not.toBe(original);
    expect(Date.parse(back.generated)).toBeGreaterThan(Date.parse(original));
  });

  it('throws on invalid plan input', () => {
    const bogus = { schema_version: 1 } as unknown as ValidPlan;
    expect(() => write(bogus, { projectRoot: tmpRoot })).toThrow(/invalid plan/);
  });
});

// ──────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────

describe('CLI', () => {
  it('empty subcommand emits a valid YAML plan', () => {
    const out = execFileSync('node', [SCRIPT, 'empty', '--source', 'auto'], { encoding: 'utf8' });
    expect(out).toMatch(/^schema_version: 1$/m);
    expect(out).toMatch(/^source: auto$/m);
  });

  it('read subcommand returns exists:false for missing plan', () => {
    const out = execFileSync('node', [SCRIPT, 'read', '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    expect(parsed.exists).toBe(false);
    expect(parsed.plan).toBeNull();
  });

  it('write subcommand accepts stdin and produces the file', () => {
    const empty = execFileSync('node', [SCRIPT, 'empty', '--source', 'auto'], { encoding: 'utf8' });
    const out = execFileSync('node', [SCRIPT, 'write', '--project-root', tmpRoot], {
      encoding: 'utf8',
      input: empty,
    });
    expect(JSON.parse(out).wrote).toBe(true);
    expect(existsSync(planPath(tmpRoot))).toBe(true);
  });

  it('validate subcommand rejects invalid stdin with exit code 1', () => {
    const r = spawnSync('node', [SCRIPT, 'validate', '--project-root', tmpRoot], {
      encoding: 'utf8',
      input: '{"foo": "bar"}',
    });
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.code).toBe('missing_schema_version');
  });

  it('read of a corrupt file returns error JSON and exits 1', () => {
    const file = planPath(tmpRoot);
    mkdirSync(file.replace(/sprint-plan\.yaml$/, ''), { recursive: true });
    writeFileSync(file, 'broken: : yaml :\n');
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync('node', [SCRIPT, 'read', '--project-root', tmpRoot], {
        encoding: 'utf8',
      });
    } catch (e) {
      const err = e as { stdout?: Buffer; status?: number };
      stdout = err.stdout ? err.stdout.toString('utf8') : '';
      exitCode = err.status ?? 0;
    }
    const parsed = JSON.parse(stdout);
    expect(parsed.exists).toBe(true);
    expect(parsed.error).toBe('parse_error');
    expect(exitCode).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// File round-trip via a realistic plan
// ──────────────────────────────────────────────────────────────────

describe('round-trip a populated plan', () => {
  it('preserves all top-level fields verbatim', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.notes = 'sprint-2 priorities';
    plan.dependencies.stories = {
      '1-3-add-auth': {
        depends_on: ['1-1-bootstrap', '1-2-models'],
        rationale: 'needs base + models',
      },
    };
    plan.cross_epic_deps = [
      {
        from_story: '4-3-foo',
        to_story: '3-1-bar',
        rationale: 'schema dep',
        inferred_at: '2026-05-19T00:00:00Z',
      },
    ];
    plan.overrides = [{ epic: '2', force_independent: ['2-1'], force_sequential: ['2-3', '2-4'] }];
    plan.issue_tracker = {
      provider: 'jira',
      base_url: 'https://co.atlassian.net',
      project_key: 'PROJ',
    };
    write(plan, { projectRoot: tmpRoot });
    const back = read({ projectRoot: tmpRoot }) as ValidPlan;
    expect(back.notes).toBe('sprint-2 priorities');
    expect((back.dependencies.stories as Record<string, unknown>)['1-3-add-auth']).toEqual({
      depends_on: ['1-1-bootstrap', '1-2-models'],
      rationale: 'needs base + models',
    });
    expect(back.cross_epic_deps).toEqual(plan.cross_epic_deps);
    expect(back.overrides).toEqual(plan.overrides);
    expect(back.issue_tracker).toEqual(plan.issue_tracker);
  });
});
