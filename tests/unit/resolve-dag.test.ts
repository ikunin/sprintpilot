import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import dagMod from '../../_Sprintpilot/scripts/resolve-dag.js';
// @ts-expect-error — CommonJS module
import sprintPlanMod from '../../_Sprintpilot/scripts/sprint-plan.js';
import yaml from 'js-yaml';

const {
  parseEpicFromKey,
  edgesFromExplicit,
  edgesFromOrdering,
  applyForceIndependent,
  buildEdges,
  topoLayers,
  buildDag,
} = dagMod as {
  parseEpicFromKey: (k: string) => string | null;
  edgesFromExplicit: (doc: unknown, nodes: string[]) => Array<[string, string]>;
  edgesFromOrdering: (nodes: string[]) => Array<[string, string]>;
  applyForceIndependent: (edges: Array<[string, string]>, doc: unknown) => Array<[string, string]>;
  buildEdges: (
    strats: string[],
    nodes: string[],
    doc: unknown,
    opts?: { includeCrossEpic?: boolean },
  ) => Array<[string, string]>;
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
};

const { emptyPlan, planPath } = sprintPlanMod as {
  emptyPlan: (opts?: { source?: string }) => Record<string, unknown>;
  planPath: (root: string) => string;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'resolve-dag.js');

let tmpRoot = '';

// Helper: write sprint-status + (optionally) a sprint-plan.yaml.
// `deps` is a YAML string in the LEGACY shape (version + stories + overrides);
// we parse it and lift the relevant blocks into a valid sprint-plan.yaml so
// the new resolve-dag (which reads sprint-plan.yaml) sees the same data.
function seed(projectRoot: string, status: string, deps?: string) {
  mkdirSync(join(projectRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
  writeFileSync(
    join(projectRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
    status,
  );
  if (deps !== undefined) {
    const legacy = yaml.load(deps) as { stories?: Record<string, unknown>; overrides?: unknown[] };
    const plan = emptyPlan({ source: 'auto' });
    (plan.dependencies as { stories: Record<string, unknown> }).stories =
      (legacy && typeof legacy === 'object' && legacy.stories) || {};
    if (legacy && Array.isArray(legacy.overrides)) plan.overrides = legacy.overrides;
    writeFileSync(planPath(projectRoot), yaml.dump(plan));
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

// parseDependenciesYaml describe block removed — the hand-rolled parser
// was deleted in v2.3.0; sprint-plan.yaml is read via js-yaml in
// sprint-plan.js (covered by tests/unit/sprint-plan.test.ts).

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

  it('v2.3.4 regression: ordering is suppressed when explicit produced edges (no fake cycle)', () => {
    // Reproduces the jarvis epic-6 cycle: an explicit "6-1 depends on 6-3"
    // emits 6-3 → 6-1 (backwards against story order). With ordering's
    // linear chain 6-1 → 6-2 → 6-3 added on top, this closes a fake
    // cycle 6-3 → 6-1 → 6-2 → 6-3 that the user never declared. The fix
    // suppresses ordering whenever explicit produced any edges.
    const nodes = ['6-1', '6-2', '6-3', '6-4', '6-5', '6-6'];
    const doc = {
      stories: {
        '6-1': { depends_on: ['6-3', '6-4'] },
        '6-4': { depends_on: ['6-3'] },
        '6-5': { depends_on: ['6-3', '6-4'] },
      },
    };
    const edges = buildEdges(['explicit', 'ordering'], nodes, doc);
    // Only explicit edges should remain — no linear-chain edges.
    expect(edges).toContainEqual(['6-3', '6-1']);
    expect(edges).toContainEqual(['6-4', '6-1']);
    expect(edges).toContainEqual(['6-3', '6-4']);
    expect(edges).toContainEqual(['6-3', '6-5']);
    expect(edges).toContainEqual(['6-4', '6-5']);
    expect(edges.length).toBe(5);
    // Ordering's linear-chain edges must NOT be present.
    expect(edges).not.toContainEqual(['6-1', '6-2']);
    expect(edges).not.toContainEqual(['6-2', '6-3']);
    expect(edges).not.toContainEqual(['6-5', '6-6']);
  });

  it('ordering still applies when explicit is empty (greenfield epic with no declared deps)', () => {
    const nodes = ['1-1-a', '1-2-b', '1-3-c'];
    const doc = { stories: {} };
    const edges = buildEdges(['explicit', 'ordering'], nodes, doc);
    expect(edges).toEqual([
      ['1-1-a', '1-2-b'],
      ['1-2-b', '1-3-c'],
    ]);
  });

  it('ordering also suppressed when explicit edges come only from cross_epic_deps', () => {
    const nodes = ['1-1', '1-2', '2-1'];
    const doc = {
      cross_epic_deps: [{ from_story: '2-1', to_story: '1-2' }],
    };
    const edges = buildEdges(['explicit', 'ordering'], nodes, doc, { includeCrossEpic: true });
    // Cross-epic edge present (emitted as [to, from] = ['1-2', '2-1']).
    expect(edges).toContainEqual(['1-2', '2-1']);
    // Ordering's linear chain is suppressed even though only cross-epic
    // produced explicit edges (no per-epic depends_on entries).
    expect(edges).not.toContainEqual(['1-1', '1-2']);
    expect(edges).not.toContainEqual(['1-2', '2-1'].slice(0).reverse() as [string, string]);
    expect(edges.length).toBe(1);
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

// scaffoldDependenciesYaml describe block removed — the `scaffold`
// subcommand was deleted in v2.3.0. The sprint-plan.js `empty` subcommand
// fills the same role (covered in tests/unit/sprint-plan.test.ts).

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

  it('v2.3.6: mermaid render reports svg_reason="mmdc-missing" when Mermaid CLI is absent from PATH', () => {
    seed(
      tmpRoot,
      'development_status:\n  1-1-a: ready-for-dev\n  1-2-b: backlog\n',
    );
    const outputPath = join(tmpRoot, '_bmad-output', 'dag.mmd');
    // Run with an empty PATH so mmdc cannot be resolved regardless of
    // whether it's installed on the test machine. (Empty string would
    // make spawnSync fall back to system defaults on some platforms; a
    // single non-existent directory is unambiguous.)
    const isolated = join(tmpRoot, 'no-such-bin');
    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        'render',
        '--format',
        'mermaid',
        '--epic',
        '1',
        '--output',
        outputPath,
        '--project-root',
        tmpRoot,
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: isolated } },
    );
    const envelope = JSON.parse(out);
    expect(envelope.wrote).toBe(true);
    expect(envelope.file).toBe(outputPath);
    expect(envelope.svg_reason).toBe('mmdc-missing');
    expect(envelope.svg_file).toBeUndefined();
  });

  // Skipped on Windows: the shim is a POSIX shell script. The
  // production code IS Windows-aware (resolves mmdc.cmd/.ps1/.bat/.exe
  // explicitly because Node's spawn doesn't auto-resolve PATHEXT), but
  // testing that path needs a Windows .cmd shim — out of scope here.
  // The mmdc-missing test above covers the cross-platform absent case.
  (process.platform === 'win32' ? it.skip : it)('mermaid render produces a sibling SVG (no PNG) when mmdc is on PATH', () => {
    seed(
      tmpRoot,
      'development_status:\n  1-1-a: ready-for-dev\n  1-2-b: backlog\n',
    );
    // Shim mmdc into a temp dir on PATH. The shim ignores most flags;
    // for `--version` it prints a string; otherwise it touches whatever
    // path follows `-o` and exits 0. That's enough to exercise the
    // happy path in resolve-dag's spawnSync wrapper.
    const shimDir = join(tmpRoot, 'mmdc-shim');
    mkdirSync(shimDir, { recursive: true });
    const shimPath = join(shimDir, 'mmdc');
    writeFileSync(
      shimPath,
      '#!/bin/sh\n' +
        '[ "$1" = "--version" ] && echo "shim" && exit 0\n' +
        'output_next=\n' +
        'for arg in "$@"; do\n' +
        '  if [ -n "$output_next" ]; then : > "$arg"; output_next=; continue; fi\n' +
        '  [ "$arg" = "-o" ] && output_next=1\n' +
        'done\n' +
        'exit 0\n',
      { mode: 0o755 },
    );
    const outputPath = join(tmpRoot, '_bmad-output', 'dag.mmd');
    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        'render',
        '--format',
        'mermaid',
        '--epic',
        '1',
        '--output',
        outputPath,
        '--project-root',
        tmpRoot,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      },
    );
    const envelope = JSON.parse(out);
    expect(envelope.wrote).toBe(true);
    // Only SVG is produced — vector, crisp at any zoom, small on disk.
    // PNG generation was removed.
    expect(envelope.svg_file).toBe(outputPath.replace(/\.mmd$/, '.svg'));
    expect(envelope.svg_reason).toBeUndefined();
    expect(existsSync(envelope.svg_file)).toBe(true);
    // No PNG sibling or PNG metadata in the envelope.
    expect(envelope.png_file).toBeUndefined();
    expect(envelope.png_dimensions).toBeUndefined();
    expect(existsSync(outputPath.replace(/\.mmd$/, '.png'))).toBe(false);
  });


  it('v2.3.5 regression: mermaid output puts "flowchart" on the first line (strict-renderer compatibility)', () => {
    // Reproduces the jarvis report: Claude Code's chat renderer (and
    // some markdown→mermaid pipelines) detect mermaid by sniffing the
    // first non-blank line for a diagram type. Leading `%%` comments
    // caused them to silently skip rendering.
    seed(
      tmpRoot,
      'development_status:\n  1-1-a: ready-for-dev\n  1-2-b: backlog\n',
    );
    const outputPath = join(tmpRoot, '_bmad-output', 'dag.mmd');
    execFileSync(process.execPath, [
      SCRIPT,
      'render',
      '--format',
      'mermaid',
      '--epic',
      '1',
      '--output',
      outputPath,
      '--project-root',
      tmpRoot,
    ]);
    const rendered = readFileSync(outputPath, 'utf8');
    const firstNonBlankLine = rendered
      .split('\n')
      .find((line) => line.trim().length > 0);
    expect(firstNonBlankLine).toBe('flowchart LR');
    // Sanity: %% comments still present after the type declaration.
    expect(rendered).toMatch(/^flowchart LR\n%% plan-id:/m);
  });

});
