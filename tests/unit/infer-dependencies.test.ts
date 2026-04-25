import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import inferMod from '../../_Sprintpilot/scripts/infer-dependencies.js';
// @ts-expect-error — CommonJS module
import dagMod from '../../_Sprintpilot/scripts/resolve-dag.js';

const {
  AUTO_MARKER,
  validateEnvelope,
  readExisting,
  mergeDoc,
  contentHash,
  renderYaml,
  inlineScalar,
  diffCounts,
  scaffoldPrompt,
} = inferMod as {
  AUTO_MARKER: string;
  validateEnvelope: (env: unknown, ctx: { projectRoot: string; epic: string }) => {
    valid: boolean;
    errors: { code: string; [k: string]: unknown }[];
  };
  readExisting: (root: string) => {
    exists: boolean;
    autoMarker: boolean;
    doc: Record<string, unknown> | null;
    raw: string | null;
  };
  mergeDoc: (env: Record<string, unknown>, existing: { doc: Record<string, unknown> | null }) => Record<string, unknown>;
  contentHash: (doc: Record<string, unknown>) => string;
  renderYaml: (doc: Record<string, unknown>, hash: string) => string;
  inlineScalar: (v: unknown) => string;
  diffCounts: (
    prev: Record<string, unknown> | null,
    next: Record<string, unknown>,
  ) => { added: number; removed: number };
  scaffoldPrompt: (root: string, epic: string) => string;
};

const { parseDependenciesYaml } = dagMod as {
  parseDependenciesYaml: (raw: string) => Record<string, unknown>;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'infer-dependencies.js');
const RESOLVE_DAG = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'resolve-dag.js');
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'infer-dependencies');

let tmpRoot = '';

function seedFixtureProject(): string {
  // Build a temp project with sprint-status from fixtures.
  const root = mkdtempSync(join(tmpdir(), 'sp-infer-'));
  const impl = join(root, '_bmad-output', 'implementation-artifacts');
  const planning = join(root, '_bmad-output', 'planning-artifacts');
  mkdirSync(impl, { recursive: true });
  mkdirSync(planning, { recursive: true });
  writeFileSync(
    join(impl, 'sprint-status.yaml'),
    readFileSync(join(FIXTURES, 'sprint-status.minimal.yaml'), 'utf8'),
  );
  writeFileSync(join(planning, 'epics.md'), readFileSync(join(FIXTURES, 'epics.minimal.md'), 'utf8'));
  writeFileSync(
    join(planning, 'architecture.md'),
    readFileSync(join(FIXTURES, 'architecture.minimal.md'), 'utf8'),
  );
  return root;
}

function loadValidEnvelope(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, 'llm-output.valid.json'), 'utf8'));
}

beforeEach(() => {
  tmpRoot = seedFixtureProject();
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────
// validateEnvelope
// ──────────────────────────────────────────────────────────────────

describe('validateEnvelope', () => {
  it('accepts a well-formed envelope referencing only valid sprint keys', () => {
    const env = loadValidEnvelope();
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects version !== 1', () => {
    const env = { ...loadValidEnvelope(), version: 2 };
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'schema', field: 'version' });
  });

  it('rejects mismatched epic', () => {
    const env = { ...loadValidEnvelope(), epic: '2' };
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'schema' && (e as { field?: string }).field === 'epic')).toBe(true);
  });

  it('rejects dep array that is not an array', () => {
    const env = { ...loadValidEnvelope(), dependencies: { '1-2-user-profile': '1-1-data-model' } };
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'schema', field: 'dependencies.1-2-user-profile' });
  });

  it('rejects unknown keys (in dependencies)', () => {
    const env = {
      ...loadValidEnvelope(),
      dependencies: { '1-99-missing': ['1-1-data-model'] },
      rationale: { '1-99-missing': 'spurious' },
    };
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'unknown-key' && (e as { key?: string }).key === '1-99-missing')).toBe(true);
  });

  it('rejects unknown deps (in dep array)', () => {
    const env = {
      ...loadValidEnvelope(),
      dependencies: { '1-2-user-profile': ['1-99-ghost'] },
      rationale: { '1-2-user-profile': 'cites a ghost' },
    };
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'unknown-key' && (e as { key?: string }).key === '1-99-ghost')).toBe(true);
  });

  it('rejects self-dependency', () => {
    const env = {
      version: 1,
      epic: '1',
      dependencies: { '1-2-user-profile': ['1-2-user-profile'] },
      rationale: { '1-2-user-profile': 'self-cite' },
    };
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'self-dep')).toBe(true);
  });

  it('rejects cross-epic edge', () => {
    const env = {
      version: 1,
      epic: '1',
      dependencies: { '1-2-user-profile': ['2-1-other-epic'] },
      rationale: { '1-2-user-profile': 'cross-epic citation' },
    };
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'cross-epic-dep')).toBe(true);
  });

  it('rejects missing rationale for a declared edge', () => {
    const env = {
      version: 1,
      epic: '1',
      dependencies: { '1-2-user-profile': ['1-1-data-model'] },
      rationale: {},
    };
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'schema' && (e as { field?: string }).field === 'rationale.1-2-user-profile')).toBe(true);
  });

  it('rejects rationale supplied for a key not in dependencies', () => {
    const env = {
      version: 1,
      epic: '1',
      dependencies: {},
      rationale: { '1-2-user-profile': 'orphan rationale' },
    };
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'schema' && (e as { field?: string }).field === 'rationale.1-2-user-profile')).toBe(true);
  });

  it('rejects cycles', () => {
    const env = {
      version: 1,
      epic: '1',
      dependencies: {
        '1-1-data-model': ['1-2-user-profile'],
        '1-2-user-profile': ['1-1-data-model'],
      },
      rationale: { '1-1-data-model': 'a', '1-2-user-profile': 'b' },
    };
    const r = validateEnvelope(env, { projectRoot: tmpRoot, epic: '1' });
    expect(r.valid).toBe(false);
    const cycleErr = r.errors.find((e) => e.code === 'cycle');
    expect(cycleErr).toBeTruthy();
    expect((cycleErr as { nodes: string[] }).nodes.sort()).toEqual(['1-1-data-model', '1-2-user-profile']);
  });
});

// ──────────────────────────────────────────────────────────────────
// renderYaml + contentHash + idempotency
// ──────────────────────────────────────────────────────────────────

describe('renderYaml', () => {
  it('emits the auto-marker as the first line', () => {
    const merged = mergeDoc(loadValidEnvelope(), { doc: null });
    const body = renderYaml(merged, contentHash(merged));
    expect(body.split('\n')[0]).toBe(AUTO_MARKER);
  });

  it('round-trips through parseDependenciesYaml — depends_on edges intact', () => {
    const env = loadValidEnvelope();
    const merged = mergeDoc(env, { doc: null });
    const body = renderYaml(merged, contentHash(merged));
    const parsed = parseDependenciesYaml(body) as {
      stories: Record<string, { depends_on: string[] }>;
    };
    expect(parsed.stories['1-2-user-profile'].depends_on).toEqual(['1-1-data-model']);
    expect(parsed.stories['1-3-avatar-upload'].depends_on).toEqual(['1-2-user-profile']);
    expect(parsed.stories['1-4-bio-edit'].depends_on.sort()).toEqual([
      '1-1-data-model',
      '1-2-user-profile',
    ]);
  });

  it('is byte-identical on re-render with the same input (idempotency)', () => {
    const merged = mergeDoc(loadValidEnvelope(), { doc: null });
    const a = renderYaml(merged, contentHash(merged));
    const b = renderYaml(merged, contentHash(merged));
    expect(a).toBe(b);
  });
});

describe('contentHash', () => {
  it('is stable for the same structure (sorted)', () => {
    const merged = mergeDoc(loadValidEnvelope(), { doc: null });
    const h1 = contentHash(merged);
    const h2 = contentHash(merged);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{12}$/);
  });

  it('rationale-only changes do NOT change the hash', () => {
    const env1 = loadValidEnvelope();
    const env2 = JSON.parse(JSON.stringify(env1)) as typeof env1;
    (env2.rationale as Record<string, string>)['1-2-user-profile'] = 'rephrased rationale';
    const h1 = contentHash(mergeDoc(env1, { doc: null }));
    const h2 = contentHash(mergeDoc(env2, { doc: null }));
    expect(h1).toBe(h2);
  });

  it('changing a dep array DOES change the hash', () => {
    const env1 = loadValidEnvelope();
    const env2 = JSON.parse(JSON.stringify(env1)) as typeof env1;
    (env2.dependencies as Record<string, string[]>)['1-3-avatar-upload'] = ['1-1-data-model'];
    (env2.rationale as Record<string, string>)['1-3-avatar-upload'] = 'restructured';
    const h1 = contentHash(mergeDoc(env1, { doc: null }));
    const h2 = contentHash(mergeDoc(env2, { doc: null }));
    expect(h1).not.toBe(h2);
  });
});

// ──────────────────────────────────────────────────────────────────
// readExisting + mergeDoc — preservation of user overrides
// ──────────────────────────────────────────────────────────────────

describe('readExisting + mergeDoc', () => {
  it('returns exists:false when no sidecar', () => {
    const e = readExisting(tmpRoot);
    expect(e.exists).toBe(false);
    expect(e.autoMarker).toBe(false);
    expect(e.doc).toBeNull();
  });

  it('detects auto-marker on previously-written sidecar', () => {
    const merged = mergeDoc(loadValidEnvelope(), { doc: null });
    const body = renderYaml(merged, contentHash(merged));
    mkdirSync(join(tmpRoot, '_Sprintpilot', 'sprints'), { recursive: true });
    writeFileSync(join(tmpRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'), body);
    const e = readExisting(tmpRoot);
    expect(e.exists).toBe(true);
    expect(e.autoMarker).toBe(true);
  });

  it('flags hand-authored sidecar (no marker)', () => {
    mkdirSync(join(tmpRoot, '_Sprintpilot', 'sprints'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'),
      '# Hand-authored\nversion: 1\nstories: {}\n',
    );
    const e = readExisting(tmpRoot);
    expect(e.exists).toBe(true);
    expect(e.autoMarker).toBe(false);
  });

  it('preserves overrides from existing sidecar when merging', () => {
    // Seed an existing auto-marker file with an overrides block.
    mkdirSync(join(tmpRoot, '_Sprintpilot', 'sprints'), { recursive: true });
    const seedBody = [
      AUTO_MARKER,
      '# Hash: deadbeef0001',
      '',
      'version: 1',
      'stories: {}',
      'overrides:',
      '  - epic: 1',
      '    force_independent:',
      '      - 1-3-avatar-upload',
      '      - 1-4-bio-edit',
      'epics:',
      '  1:',
      '    independent: true',
      '',
    ].join('\n');
    writeFileSync(join(tmpRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'), seedBody);
    const existing = readExisting(tmpRoot);
    const merged = mergeDoc(loadValidEnvelope(), existing) as {
      overrides: { force_independent?: string[] }[];
      epics: Record<string, unknown>;
    };
    expect(merged.overrides).toHaveLength(1);
    expect(merged.overrides[0].force_independent).toEqual(['1-3-avatar-upload', '1-4-bio-edit']);
    expect(merged.epics['1']).toMatchObject({ independent: true });
  });
});

// ──────────────────────────────────────────────────────────────────
// diffCounts
// ──────────────────────────────────────────────────────────────────

describe('diffCounts', () => {
  it('counts edges added vs removed when re-running on same input', () => {
    const merged1 = mergeDoc(loadValidEnvelope(), { doc: null });
    const merged2 = mergeDoc(loadValidEnvelope(), { doc: null });
    expect(diffCounts(merged1, merged2)).toEqual({ added: 0, removed: 0 });
  });

  it('counts new edges when added', () => {
    const env1 = loadValidEnvelope();
    const env2 = JSON.parse(JSON.stringify(env1));
    env2.dependencies['1-1-data-model'] = ['1-2-user-profile']; // would create a cycle but diffCounts doesn't validate
    env2.rationale['1-1-data-model'] = 'flipped';
    const a = mergeDoc(env1, { doc: null });
    const b = mergeDoc(env2, { doc: null });
    expect(diffCounts(a, b).added).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// scaffoldPrompt
// ──────────────────────────────────────────────────────────────────

describe('scaffoldPrompt', () => {
  it('interpolates the four file paths and the epic id', () => {
    const p = scaffoldPrompt(tmpRoot, '1');
    expect(p).toContain(`_bmad-output/implementation-artifacts/sprint-status.yaml`);
    expect(p).toContain(`_bmad-output/planning-artifacts/epics.md`);
    expect(p).toContain(`_bmad-output/planning-artifacts/architecture.md`);
    expect(p).toContain(`_Sprintpilot/sprints/dependencies.yaml`);
    expect(p).toContain('epic 1');
  });
});

// ──────────────────────────────────────────────────────────────────
// CLI integration — round-trip through resolve-dag layers
// ──────────────────────────────────────────────────────────────────

describe('CLI integration', () => {
  it('write produces a file resolve-dag.js can layer (multi-layer DAG)', () => {
    const env = loadValidEnvelope();
    execFileSync(process.execPath, [SCRIPT, 'write', '--epic', '1', '--project-root', tmpRoot], {
      input: JSON.stringify(env),
      encoding: 'utf8',
    });
    // File was written with the marker.
    const body = readFileSync(
      join(tmpRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'),
      'utf8',
    );
    expect(body.startsWith(AUTO_MARKER)).toBe(true);

    // resolve-dag layers consumes it and produces a non-trivial DAG.
    const layersOut = execFileSync(process.execPath, [
      RESOLVE_DAG,
      'layers',
      '--epic',
      '1',
      '--project-root',
      tmpRoot,
    ]).toString();
    const layers = JSON.parse(layersOut) as string[][];
    // First layer must contain only 1-1-data-model (no inbound edges).
    expect(layers[0]).toEqual(['1-1-data-model']);
    // Should be at least 2 layers since 1-2 depends on 1-1.
    expect(layers.length).toBeGreaterThanOrEqual(2);
    // 1-3-avatar-upload and 1-4-bio-edit both depend on 1-2 — they end up in layer 3 together.
    const flat = layers.flat();
    expect(flat.sort()).toEqual([
      '1-1-data-model',
      '1-2-user-profile',
      '1-3-avatar-upload',
      '1-4-bio-edit',
    ]);
  });

  it('write exits 2 on hand-authored existing file (no --force)', () => {
    mkdirSync(join(tmpRoot, '_Sprintpilot', 'sprints'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'),
      'version: 1\nstories: {}\n',
    );
    const res = spawnSync(
      process.execPath,
      [SCRIPT, 'write', '--epic', '1', '--project-root', tmpRoot],
      { input: JSON.stringify(loadValidEnvelope()), encoding: 'utf8' },
    );
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout)).toMatchObject({ wrote: false, reason: 'existing-hand-authored' });
  });

  it('write --force overwrites a hand-authored file', () => {
    mkdirSync(join(tmpRoot, '_Sprintpilot', 'sprints'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'),
      'version: 1\nstories: {}\n',
    );
    const out = execFileSync(
      process.execPath,
      [SCRIPT, 'write', '--epic', '1', '--project-root', tmpRoot, '--force'],
      { input: JSON.stringify(loadValidEnvelope()), encoding: 'utf8' },
    ).toString();
    expect(JSON.parse(out)).toMatchObject({ wrote: true });
    const body = readFileSync(
      join(tmpRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'),
      'utf8',
    );
    expect(body.startsWith(AUTO_MARKER)).toBe(true);
  });

  it('dry-run returns valid:true with diff for a clean envelope', () => {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, 'dry-run', '--epic', '1', '--project-root', tmpRoot],
      { input: JSON.stringify(loadValidEnvelope()), encoding: 'utf8' },
    ).toString();
    const parsed = JSON.parse(out) as { valid: boolean; diff: { added: number } };
    expect(parsed.valid).toBe(true);
    expect(parsed.diff.added).toBeGreaterThan(0);
  });

  it('dry-run returns valid:false envelope on validation failure', () => {
    const env = { ...loadValidEnvelope(), version: 99 };
    const res = spawnSync(
      process.execPath,
      [SCRIPT, 'dry-run', '--epic', '1', '--project-root', tmpRoot],
      { input: JSON.stringify(env), encoding: 'utf8' },
    );
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({ valid: false });
  });

  it('scaffold-prompt emits a prompt to stdout', () => {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, 'scaffold-prompt', '--epic', '1', '--project-root', tmpRoot],
      { encoding: 'utf8' },
    ).toString();
    expect(out).toContain('epic 1');
    expect(out).toContain('OUTPUT — exactly one JSON object');
  });
});
