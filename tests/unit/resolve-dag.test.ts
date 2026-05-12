import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import dagMod from '../../_Sprintpilot/scripts/resolve-dag.js';

const {
  parseDependenciesYaml,
  parseEpicFromKey,
  edgesFromExplicit,
  edgesFromOrdering,
  applyForceIndependent,
  buildEdges,
  topoLayers,
  buildDag,
  scaffoldDependenciesYaml,
} = dagMod as {
  parseDependenciesYaml: (s: string) => Record<string, unknown>;
  parseEpicFromKey: (k: string) => string | null;
  edgesFromExplicit: (doc: unknown, nodes: string[]) => Array<[string, string]>;
  edgesFromOrdering: (nodes: string[]) => Array<[string, string]>;
  applyForceIndependent: (edges: Array<[string, string]>, doc: unknown) => Array<[string, string]>;
  buildEdges: (strats: string[], nodes: string[], doc: unknown) => Array<[string, string]>;
  topoLayers: (
    nodes: string[],
    edges: Array<[string, string]>,
  ) => { layers: string[][]; cycle: string[] };
  buildDag: (opts: { projectRoot: string; epic: string | null; strategies: string[] }) => {
    nodes: string[];
    edges: Array<[string, string]>;
    layers: string[][];
    width: number;
    cycle: string[];
  };
  scaffoldDependenciesYaml: (
    root: string,
    epic: string,
    opts?: { force?: boolean },
  ) => { wrote: boolean; reason?: string; file: string };
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'resolve-dag.js');

let tmpRoot = '';

function seed(projectRoot: string, status: string, deps?: string) {
  mkdirSync(join(projectRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
  writeFileSync(
    join(projectRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
    status,
  );
  if (deps !== undefined) {
    mkdirSync(join(projectRoot, '_Sprintpilot', 'sprints'), { recursive: true });
    writeFileSync(join(projectRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml'), deps);
  }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-dag-'));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('parseEpicFromKey', () => {
  it('extracts the leading numeric segment', () => {
    expect(parseEpicFromKey('1-2-foo')).toBe('1');
    expect(parseEpicFromKey('10-3-foo')).toBe('10');
    expect(parseEpicFromKey('')).toBeNull();
  });

  it('accepts non-numeric leading segments (alpha epic IDs)', () => {
    // Pre-2.0.8 returned null for any non-numeric prefix, silently
    // dropping stories like `auth-1-login` from `--epic` filtering and
    // letting infer-dependencies' cross-epic edge guards bypass.
    expect(parseEpicFromKey('auth-1-login')).toBe('auth');
    expect(parseEpicFromKey('infra-bootstrap')).toBe('infra');
    expect(parseEpicFromKey('non-numeric')).toBe('non');
  });
});

describe('parseDependenciesYaml', () => {
  it('parses nested objects, block-form lists, and list-inline mappings', () => {
    const doc = parseDependenciesYaml(`
version: 1
stories:
  1-3-c:
    depends_on:
      - 1-1-a
      - 1-2-b
  1-4-d:
    depends_on:
      - 1-3-c
overrides:
  - epic: 1
    force_independent:
      - 1-2-b
      - 1-3-c
    force_sequential: []
epics:
  "2":
    independent: true
`);
    expect(doc.version).toBe(1);
    expect((doc.stories as Record<string, { depends_on: string[] }>)['1-3-c'].depends_on).toEqual([
      '1-1-a',
      '1-2-b',
    ]);
    const ov = (doc.overrides as Array<Record<string, unknown>>)[0];
    expect(ov.epic).toBe(1);
    expect(ov.force_independent).toEqual(['1-2-b', '1-3-c']);
    expect(ov.force_sequential).toEqual([]);
    expect((doc.epics as Record<string, { independent: boolean }>)['2'].independent).toBe(true);
  });

  it('handles flow-form arrays on the value side', () => {
    const doc = parseDependenciesYaml(`stories:\n  a:\n    depends_on: ["x","y"]\n`);
    expect((doc.stories as Record<string, { depends_on: string[] }>).a.depends_on).toEqual([
      'x',
      'y',
    ]);
  });

  it('strips trailing comments', () => {
    const doc = parseDependenciesYaml('version: 1 # stable\nname: foo # ignored\n');
    expect(doc.version).toBe(1);
    expect(doc.name).toBe('foo');
  });
});

describe('edgesFromExplicit', () => {
  it('emits edges dep → key for every declared depends_on', () => {
    const doc = {
      stories: {
        b: { depends_on: ['a'] },
        c: { depends_on: ['a', 'b'] },
      },
    };
    const edges = edgesFromExplicit(doc, ['a', 'b', 'c']);
    expect(edges).toEqual(
      expect.arrayContaining([
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'c'],
      ]),
    );
    expect(edges).toHaveLength(3);
  });

  it('skips edges referring to unknown nodes (out-of-scope epic)', () => {
    const doc = { stories: { b: { depends_on: ['not-in-scope'] } } };
    expect(edgesFromExplicit(doc, ['a', 'b'])).toEqual([]);
  });

  it('honors overrides.force_sequential', () => {
    const doc = { overrides: [{ force_sequential: ['a', 'b', 'c'] }] };
    const edges = edgesFromExplicit(doc, ['a', 'b', 'c']);
    expect(edges).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
  });
});

describe('edgesFromOrdering', () => {
  it('chains nodes linearly', () => {
    expect(edgesFromOrdering(['a', 'b', 'c'])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
  });
  it('returns empty for single-node sprints', () => {
    expect(edgesFromOrdering(['a'])).toEqual([]);
  });
});

describe('applyForceIndependent', () => {
  it('removes ONLY inbound edges for listed keys (not outbound)', () => {
    // The contract: `force_independent: [b]` means "let b run any time,
    // regardless of its declared deps". Stories that depend on b must
    // STILL wait for b. Pre-2.0.8 this stripped both directions, so c
    // (depends_on: [b]) became a free root and dispatched in parallel
    // with b — a silent merge-conflict scenario.
    const edges: Array<[string, string]> = [
      ['a', 'b'], // inbound to b — drop
      ['b', 'c'], // outbound from b — keep (c still depends on b)
      ['c', 'd'], // unrelated — keep
    ];
    const filtered = applyForceIndependent(edges, { overrides: [{ force_independent: ['b'] }] });
    expect(filtered).toEqual([
      ['b', 'c'],
      ['c', 'd'],
    ]);
  });
  it('no-ops when no overrides are declared', () => {
    const edges: Array<[string, string]> = [['a', 'b']];
    expect(applyForceIndependent(edges, null)).toEqual(edges);
    expect(applyForceIndependent(edges, { overrides: [] })).toEqual(edges);
  });
});

describe('topoLayers', () => {
  it('produces layered output for a diamond', () => {
    // a → b, a → c, b → d, c → d
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'd'],
      ['c', 'd'],
    ];
    const { layers, cycle } = topoLayers(['a', 'b', 'c', 'd'], edges);
    expect(layers).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(cycle).toEqual([]);
  });

  it('detects cycles and returns the unplaced nodes', () => {
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['b', 'a'],
    ];
    const { layers, cycle } = topoLayers(['a', 'b'], edges);
    expect(layers).toEqual([]);
    expect(cycle.length).toBe(2);
  });
});

describe('buildEdges', () => {
  it('explicit > ordering: explicit wins; force_independent strips inbound edges only', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    const doc = { overrides: [{ force_independent: ['b', 'c'] }] };
    // ordering alone produces a→b→c→d. force_independent: [b, c] drops
    // INBOUND edges to b and c — i.e. a→b and b→c. The c→d edge stays
    // because it's outbound from c (stories that depend on c must still
    // wait for c). Pre-2.0.8 stripped both directions.
    const edges = buildEdges(['explicit', 'ordering'], nodes, doc);
    // Inbound edges to b and c are gone:
    expect(edges.filter(([, b]) => b === 'b' || b === 'c').length).toBe(0);
    // Outbound c→d survives:
    expect(edges).toContainEqual(['c', 'd']);
  });
});

describe('buildDag — full pipeline', () => {
  it('missing sidecar → linear chain from sprint-status order', () => {
    seed(
      tmpRoot,
      'development_status:\n  1-1-a: ready-for-dev\n  1-2-b: backlog\n  1-3-c: backlog\n',
    );
    const dag = buildDag({ projectRoot: tmpRoot, epic: '1', strategies: ['explicit', 'ordering'] });
    expect(dag.nodes).toEqual(['1-1-a', '1-2-b', '1-3-c']);
    expect(dag.layers).toEqual([['1-1-a'], ['1-2-b'], ['1-3-c']]);
    expect(dag.width).toBe(1);
    expect(dag.cycle).toEqual([]);
  });

  it('sidecar with force_independent widens the layer', () => {
    seed(
      tmpRoot,
      'development_status:\n  1-1-a: ready-for-dev\n  1-2-b: backlog\n  1-3-c: backlog\n  1-4-d: backlog\n',
      'version: 1\noverrides:\n  - epic: 1\n    force_independent:\n      - 1-2-b\n      - 1-3-c\n',
    );
    const dag = buildDag({ projectRoot: tmpRoot, epic: '1', strategies: ['explicit', 'ordering'] });
    expect(dag.width).toBeGreaterThan(1);
  });

  it('epic filter keeps only matching-epic stories', () => {
    seed(
      tmpRoot,
      'development_status:\n  1-1-a: ready-for-dev\n  2-1-b: backlog\n  2-2-c: backlog\n',
    );
    const dag = buildDag({ projectRoot: tmpRoot, epic: '2', strategies: ['explicit', 'ordering'] });
    expect(dag.nodes).toEqual(['2-1-b', '2-2-c']);
  });

  it('epic filter works with non-numeric (alpha) epic IDs', () => {
    // Pre-2.0.8: parseEpicFromKey returned null for non-numeric prefixes,
    // so --epic auth would silently match nothing. Now alpha epic IDs
    // work end-to-end.
    seed(
      tmpRoot,
      'development_status:\n  auth-1-login: ready-for-dev\n  auth-2-logout: backlog\n  infra-1-bootstrap: backlog\n',
    );
    const dag = buildDag({
      projectRoot: tmpRoot,
      epic: 'auth',
      strategies: ['explicit', 'ordering'],
    });
    expect(dag.nodes).toEqual(['auth-1-login', 'auth-2-logout']);
  });

  it('reads stories from a sprint-status file with 4-space indentation', () => {
    // Pre-2.0.8: a 4-space-indented file silently produced zero stories
    // because the regex hardcoded a 2-space match. Now the first key's
    // indent is auto-detected per block.
    seed(tmpRoot, 'development_status:\n    1-1-a: ready-for-dev\n    1-2-b: backlog\n');
    const dag = buildDag({ projectRoot: tmpRoot, epic: '1', strategies: ['explicit', 'ordering'] });
    expect(dag.nodes).toEqual(['1-1-a', '1-2-b']);
  });

  it('reads stories from a tab-indented sprint-status file', () => {
    seed(tmpRoot, 'development_status:\n\t1-1-a: ready-for-dev\n\t1-2-b: backlog\n');
    const dag = buildDag({ projectRoot: tmpRoot, epic: '1', strategies: ['explicit', 'ordering'] });
    expect(dag.nodes).toEqual(['1-1-a', '1-2-b']);
  });

  it('still excludes nested per-story fields at deeper indents', () => {
    // Block-form sprint-status: nested fields should NOT be picked up
    // as story keys.
    seed(
      tmpRoot,
      [
        'development_status:',
        '  1-1-a:',
        '    status: ready-for-dev',
        '    pr_url: https://example.com/pr/1',
        '  1-2-b:',
        '    status: backlog',
        '',
      ].join('\n'),
    );
    const dag = buildDag({ projectRoot: tmpRoot, epic: '1', strategies: ['explicit', 'ordering'] });
    expect(dag.nodes).toEqual(['1-1-a', '1-2-b']);
  });

  it('force_sequential dedupes a key listed multiple times (does not produce a self-cycle)', () => {
    // Pre-2.0.8: `force_sequential: ['a', 'b', 'a']` produced edges
    // `a→b, b→a` — instant cycle. Kahn's later rejected it with an
    // opaque "cycle detected" error. Now duplicates are filtered with a
    // warning so the user sees a clear message.
    seed(
      tmpRoot,
      'development_status:\n  1-1-a: backlog\n  1-2-b: backlog\n',
      'version: 1\noverrides:\n  - epic: 1\n    force_sequential:\n      - 1-1-a\n      - 1-2-b\n      - 1-1-a\n',
    );
    const dag = buildDag({ projectRoot: tmpRoot, epic: '1', strategies: ['explicit', 'ordering'] });
    // No cycle — the dedupe drops the second 1-1-a, leaving edges
    // a→b only. Layers: [[a], [b]].
    expect(dag.cycle).toEqual([]);
    expect(dag.layers).toEqual([['1-1-a'], ['1-2-b']]);
  });
});

describe('scaffoldDependenciesYaml', () => {
  it('writes a new sidecar when none exists', () => {
    seed(tmpRoot, 'development_status:\n  1-1-a: ready-for-dev\n  1-2-b: backlog\n');
    const r = scaffoldDependenciesYaml(tmpRoot, '1');
    expect(r.wrote).toBe(true);
    expect(existsSync(r.file)).toBe(true);
    const body = readFileSync(r.file, 'utf8');
    expect(body).toContain('Sprintpilot dependency sidecar');
  });

  it('refuses to overwrite unless --force', () => {
    seed(tmpRoot, 'development_status:\n  1-1-a: ready-for-dev\n');
    scaffoldDependenciesYaml(tmpRoot, '1');
    const r2 = scaffoldDependenciesYaml(tmpRoot, '1');
    expect(r2.wrote).toBe(false);
    expect(r2.reason).toBe('exists');
    const r3 = scaffoldDependenciesYaml(tmpRoot, '1', { force: true });
    expect(r3.wrote).toBe(true);
  });
});

describe('CLI integration', () => {
  it('layers for an epic prints JSON', () => {
    seed(tmpRoot, 'development_status:\n  1-1-a: ready-for-dev\n  1-2-b: backlog\n');
    const out = execFileSync(process.execPath, [
      SCRIPT,
      'layers',
      '--epic',
      '1',
      '--project-root',
      tmpRoot,
    ]).toString();
    expect(JSON.parse(out)).toEqual([['1-1-a'], ['1-2-b']]);
  });

  it('exits 1 with cycle diagnostic when dependencies form a loop', () => {
    seed(
      tmpRoot,
      'development_status:\n  1-1-a: backlog\n  1-2-b: backlog\n',
      'version: 1\nstories:\n  1-1-a:\n    depends_on:\n      - 1-2-b\n  1-2-b:\n    depends_on:\n      - 1-1-a\n',
    );
    const res = spawnSync(
      process.execPath,
      [SCRIPT, 'layers', '--epic', '1', '--project-root', tmpRoot],
      {
        encoding: 'utf8',
      },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/cycle detected/);
  });

  it('scaffold refuses to run without --epic', () => {
    const res = spawnSync(process.execPath, [SCRIPT, 'scaffold', '--project-root', tmpRoot]);
    expect(res.status).toBe(1);
  });
});
