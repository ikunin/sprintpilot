#!/usr/bin/env node

// resolve-dag.js — build the story execution DAG for a sprint.
//
// Usage:
//   resolve-dag.js graph   [--epic <id>] [--project-root <path>] [--strategy <list>]
//   resolve-dag.js layers  [--epic <id>] [--project-root <path>] [--strategy <list>]
//   resolve-dag.js width   [--epic <id>] [--project-root <path>] [--strategy <list>]
//   resolve-dag.js scaffold --epic <id> [--project-root <path>] [--force]
//
// Strategies (default order: explicit,ordering):
//   explicit  — read _Sprintpilot/sprints/dependencies.yaml
//   ordering  — linear chain from sprint-status.yaml order (safe default)
//   files     — (TODO in PR 9.1) infer edges from shared file-path touches
//
// Conflict resolution when multiple strategies contribute: explicit > files > ordering.
// Missing dependencies.yaml is fine; we fall back to the next strategy.
//
// Output:
//   graph   { "nodes": [...], "edges": [ ["a","b"], ... ], "epic": "1" }
//   layers  [[...], [...], ...]
//   width   <int>
//
// Cycle detection: Kahn's algorithm. Any node remaining after topological
// pass is part of a cycle — exit 1 with the offending nodes on stderr.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');
const shardMod = require('./state-shard.js');

const { yamlLoad, yamlDump } = shardMod;

const DEFAULT_STRATEGIES = ['explicit', 'ordering'];
const VALID_STRATEGIES = ['explicit', 'ordering', 'files'];
const VALID_COMMANDS = ['graph', 'layers', 'width', 'scaffold'];

function help() {
  log.out(
    [
      'Usage:',
      '  resolve-dag.js graph   [--epic <id>] [--strategy explicit,ordering]',
      '  resolve-dag.js layers  [--epic <id>] [--strategy explicit,ordering]',
      '  resolve-dag.js width   [--epic <id>] [--strategy explicit,ordering]',
      '  resolve-dag.js scaffold --epic <id> [--force]',
      '',
      'Strategies: explicit | ordering | files (opt-in)',
    ].join('\n'),
  );
}

// ------------------------------------------------------------------
// Reading stories / dependencies
// ------------------------------------------------------------------

function sprintStatusPath(projectRoot) {
  return path.join(projectRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml');
}

function dependenciesPath(projectRoot) {
  return path.join(projectRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml');
}

function parseEpicFromKey(storyKey) {
  // Epic id = first hyphen-delimited segment of the story key. BMad's
  // canonical convention is `<epic-num>-<story-num>-<slug>` (e.g.
  // `1-2-user-auth` → epic "1"), but nothing prevents a project from
  // using non-numeric epic identifiers (`auth-1-login`, `infra-bootstrap`).
  // Pre-2.0.8 this function rejected any non-numeric prefix and returned
  // null, which silently dropped stories from `--epic` filtering AND let
  // `infer-dependencies.js` cross-epic edge guards bypass for keys with
  // no numeric prefix. We now accept any non-empty alphanumeric leading
  // segment.
  const s = String(storyKey);
  if (!s) return null;
  const m = s.match(/^([A-Za-z0-9]+)(?:-|$)/);
  return m ? m[1] : null;
}

function readStoriesFromStatus(projectRoot, epicFilter) {
  const file = sprintStatusPath(projectRoot);
  if (!fs.existsSync(file)) return { ordered: [], byKey: {} };
  const raw = fs.readFileSync(file, 'utf8');
  // Pull out story keys by scanning indented `<key>:` lines under
  // `development_status:` (BMad's canonical shape) and under `stories:`
  // (alternate shape some projects use). We intentionally don't parse the
  // whole YAML — sprint-status is BMad-owned and its schema varies.
  //
  // Pre-2.0.8 this hardcoded a 2-space indent. A 4-space or tab-indented
  // file silently produced zero stories → empty layer → dispatch never
  // engaged, no warning. Now we detect the FIRST key's indent inside
  // each stories block and accept only that level (so nested per-story
  // fields at deeper indents are still correctly excluded).
  const ordered = [];
  const byKey = {};
  const lines = raw.split(/\r?\n/);
  let inStoriesBlock = false;
  let storyIndent = null;
  for (const rawLine of lines) {
    const trimmed = rawLine.trimEnd();
    if (/^(development_status|stories):\s*$/.test(trimmed)) {
      inStoriesBlock = true;
      storyIndent = null; // re-detect for each block
      continue;
    }
    // Bail out of the stories block on a top-level key.
    if (inStoriesBlock && /^\S/.test(trimmed)) {
      inStoriesBlock = false;
      storyIndent = null;
    }
    if (!inStoriesBlock) continue;
    const m = trimmed.match(/^([\t ]+)([A-Za-z0-9][A-Za-z0-9-]*):\s*(\S+)?/);
    if (!m) continue;
    const indent = m[1];
    const key = m[2];
    const statusRaw = m[3];
    if (storyIndent === null) storyIndent = indent;
    else if (indent !== storyIndent) continue; // nested field at deeper indent
    const status = statusRaw ? statusRaw.replace(/^["']|["']$/g, '') : null;
    if (epicFilter !== null && parseEpicFromKey(key) !== epicFilter) continue;
    if (!(key in byKey)) {
      ordered.push(key);
      byKey[key] = { key, status, epic: parseEpicFromKey(key) };
    }
  }
  return { ordered, byKey };
}

function readDependencies(projectRoot) {
  const file = dependenciesPath(projectRoot);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return parseDependenciesYaml(raw);
  } catch (e) {
    log.warn(`failed to parse ${file}: ${e.message}`);
    return null;
  }
}

// Purpose-built YAML parser for dependencies.yaml. Supports the hand-
// authored shape from the PR 9 plan: nested objects, block-form lists
// (`- item` and `- key: value`), and flow-form arrays (`["a","b"]`) on
// the value side of a key. Deliberately narrower than a full YAML impl
// to keep the script dep-free in user projects.
//
// Design:
//   One stack frame per "open container" (root + any parent whose
//   pendingKey value is an in-progress object or list). pendingKey names
//   the last key assigned in this container.
//
//   On a deeper-indent line, if top.pendingKey is set AND points at an
//   object/list that hasn't been "closed" yet, we descend into it by
//   pushing a new frame whose container is top.container[pendingKey].
//
//   List items attach to the current frame's pendingKey: promote the
//   container[pendingKey] from {} to [] on first list item.
function parseDependenciesYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, container: root, pendingKey: null, pendingKeyIndent: -1 }];

  const parseScalar = (raw) => {
    if (raw === '' || raw === 'null' || raw === '~') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === '[]') return [];
    if (raw === '{}') return {};
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      try {
        return raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1);
      } catch {
        return raw.slice(1, -1);
      }
    }
    if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
    if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
    return raw;
  };

  const descendIfDeeper = (indent) => {
    // Descend into top.pendingKey's value iff this line is strictly deeper
    // than the line that assigned the pendingKey. Using top.indent here is
    // wrong — a freshly-popped sibling at the same logical depth would be
    // incorrectly absorbed as a child. pendingKeyIndent tracks where the
    // pendingKey was assigned; only indents past that are true descendants.
    const top = stack[stack.length - 1];
    if (top.pendingKey === null) return;
    if (indent <= top.pendingKeyIndent) return;
    const child = top.container[top.pendingKey];
    if (!child || typeof child !== 'object') return;
    stack.push({ indent, container: child, pendingKey: null, pendingKeyIndent: -1 });
  };

  for (const rawLine of lines) {
    const hashIdx = rawLine.indexOf('#');
    let line = rawLine;
    if (hashIdx !== -1) {
      if (hashIdx === 0 || /\s/.test(rawLine[hashIdx - 1])) line = rawLine.slice(0, hashIdx);
    }
    const trimRight = line.replace(/\s+$/, '');
    if (!trimRight.trim()) continue;
    const indent = (trimRight.match(/^( *)/) || ['', ''])[1].length;
    const rest = trimRight.slice(indent);

    // Pop frames we've outdented past. List-item frames (fromListItem) are
    // kept while `indent == top.indent` — the list-item's inline key and
    // any sibling keys share the same indent and all belong to that entry.
    while (stack.length > 1) {
      const t = stack[stack.length - 1];
      const strict = t.fromListItem ? t.indent > indent : t.indent >= indent;
      if (!strict) break;
      stack.pop();
    }

    if (rest.startsWith('- ') || rest === '-') {
      // List item attaches to current frame's pendingKey.
      const owner = stack[stack.length - 1];
      const key = owner.pendingKey;
      if (!key) continue; // malformed — list item with no owner key
      if (!Array.isArray(owner.container[key])) owner.container[key] = [];
      const arr = owner.container[key];
      const content = rest === '-' ? '' : rest.slice(2).trim();
      const colon = findTopLevelColon(content);
      if (content === '') {
        arr.push(null);
      } else if (colon === -1) {
        arr.push(parseScalar(content));
      } else {
        // Inline mapping: "- k: v" or "- k:" starts a new object item.
        const k = unquoteKey(content.slice(0, colon).trim());
        const v = content.slice(colon + 1).trim();
        const item = {};
        arr.push(item);
        if (v === '' || v === '~') {
          item[k] = {};
        } else {
          item[k] = parseScalar(v);
        }
        // Subsequent deeper-indent lines that describe this item start at
        // indent + 2 (after "- "). Push a frame at indent + 2 whose
        // container is the new item, with pendingKey = k.
        // `fromListItem` tells the pop rule that sibling keys at the same
        // indent are continuations of this list entry, not outdent siblings.
        stack.push({
          indent: indent + 2,
          container: item,
          pendingKey: k,
          pendingKeyIndent: indent + 2,
          fromListItem: true,
        });
      }
      continue;
    }

    // Plain `key: value` line. First descend if we're in a deeper block
    // than the top frame and top has a pendingKey container.
    descendIfDeeper(indent);
    const top = stack[stack.length - 1];
    const colon = findTopLevelColon(rest);
    if (colon === -1) continue;
    const key = unquoteKey(rest.slice(0, colon).trim());
    const value = rest.slice(colon + 1).trim();
    if (value === '' || value === '~') {
      top.container[key] = {};
      top.pendingKey = key;
      top.pendingKeyIndent = indent;
    } else if (value === '[]') {
      top.container[key] = [];
      top.pendingKey = key;
      top.pendingKeyIndent = indent;
    } else {
      top.container[key] = parseScalar(value);
      top.pendingKey = key;
      top.pendingKeyIndent = indent;
    }
  }
  return root;
}

function unquoteKey(k) {
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    try {
      return k.startsWith('"') ? JSON.parse(k) : k.slice(1, -1);
    } catch {
      return k.slice(1, -1);
    }
  }
  return k;
}

function findTopLevelColon(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ':') return i;
  }
  return -1;
}

// ------------------------------------------------------------------
// Strategy layer
// ------------------------------------------------------------------

function edgesFromExplicit(depsDoc, nodes) {
  if (!depsDoc) return [];
  const out = [];
  const nodeSet = new Set(nodes);
  if (depsDoc.stories && typeof depsDoc.stories === 'object' && !Array.isArray(depsDoc.stories)) {
    for (const key of Object.keys(depsDoc.stories)) {
      const entry = depsDoc.stories[key];
      const deps = entry && entry.depends_on;
      if (!Array.isArray(deps)) continue;
      for (const dep of deps) {
        if (!nodeSet.has(dep) || !nodeSet.has(key)) continue;
        out.push([dep, key]);
      }
    }
  }
  // Apply overrides.force_sequential — linear chain among the listed keys.
  if (Array.isArray(depsDoc.overrides)) {
    for (const ov of depsDoc.overrides) {
      if (!ov) continue;
      if (Array.isArray(ov.force_sequential)) {
        // Filter to known nodes AND dedupe — a duplicate listing like
        // `[a, b, a]` would otherwise produce edges `a→b, b→a` (instant
        // self-cycle) that Kahn's would later reject with an opaque
        // "cycle detected" error. Reject the typo at the source instead.
        const seen = new Set();
        const seq = [];
        for (const k of ov.force_sequential) {
          if (!nodeSet.has(k)) continue;
          if (seen.has(k)) {
            log.warn(`force_sequential lists '${k}' more than once; ignoring duplicate`);
            continue;
          }
          seen.add(k);
          seq.push(k);
        }
        for (let i = 1; i < seq.length; i++) out.push([seq[i - 1], seq[i]]);
      }
    }
  }
  return out;
}

function edgesFromOrdering(nodes) {
  const out = [];
  for (let i = 1; i < nodes.length; i++) out.push([nodes[i - 1], nodes[i]]);
  return out;
}

function applyForceIndependent(edges, depsDoc) {
  if (!depsDoc || !Array.isArray(depsDoc.overrides)) return edges;
  const indep = new Set();
  for (const ov of depsDoc.overrides) {
    if (ov && Array.isArray(ov.force_independent)) {
      for (const k of ov.force_independent) indep.add(k);
    }
  }
  if (indep.size === 0) return edges;
  // Drop INBOUND edges only — `force_independent: [b]` means "let b run
  // any time, regardless of its declared deps", not "let everything that
  // depends on b also run any time". Pre-2.0.8 this stripped both
  // directions, so a story c with `depends_on: [b]` would lose its edge
  // and become a free root, then dispatch in the same layer as b — the
  // exact merge-conflict scenario the override was supposed to control.
  return edges.filter(([_a, b]) => !indep.has(b));
}

function buildEdges(strategies, nodes, depsDoc) {
  // explicit > ordering. Dedupe while preserving priority insertion order.
  const seen = new Set();
  const out = [];
  const pushEdges = (edges) => {
    for (const [a, b] of edges) {
      const key = `${a} ${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([a, b]);
    }
  };
  for (const strat of strategies) {
    if (strat === 'explicit') pushEdges(edgesFromExplicit(depsDoc, nodes));
    else if (strat === 'ordering') pushEdges(edgesFromOrdering(nodes));
    else if (strat === 'files') {
      // files strategy is opt-in and not implemented in the PR 9 scope.
      // A future sprintpilot-infer-dependencies skill can populate the
      // explicit sidecar instead.
    }
  }
  // Respect force_independent last so it removes matches from both strategies.
  return applyForceIndependent(out, depsDoc);
}

// ------------------------------------------------------------------
// Topological sort (Kahn's) + cycle detection
// ------------------------------------------------------------------

function topoLayers(nodes, edges) {
  const nodeSet = new Set(nodes);
  const inbound = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) {
    if (!nodeSet.has(a) || !nodeSet.has(b)) continue;
    adj.get(a).push(b);
    inbound.set(b, (inbound.get(b) || 0) + 1);
  }

  const layers = [];
  const placed = new Set();
  let frontier = nodes.filter((n) => inbound.get(n) === 0);
  while (frontier.length > 0) {
    // Deterministic ordering within a layer.
    frontier.sort();
    layers.push(frontier.slice());
    const next = [];
    for (const n of frontier) {
      placed.add(n);
      for (const m of adj.get(n) || []) {
        inbound.set(m, inbound.get(m) - 1);
        if (inbound.get(m) === 0) next.push(m);
      }
    }
    frontier = next;
  }

  const unplaced = nodes.filter((n) => !placed.has(n));
  return { layers, cycle: unplaced };
}

// ------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------

function parseStrategies(raw) {
  const list = (raw || DEFAULT_STRATEGIES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of list) {
    if (!VALID_STRATEGIES.includes(s)) {
      return { ok: false, error: `unknown strategy '${s}'. Valid: ${VALID_STRATEGIES.join(', ')}` };
    }
  }
  return { ok: true, value: list };
}

function buildDag({ projectRoot, epic, strategies }) {
  const { ordered } = readStoriesFromStatus(projectRoot, epic);
  if (ordered.length === 0) {
    return { nodes: [], edges: [], layers: [], width: 0, cycle: [], epic };
  }
  const depsDoc = readDependencies(projectRoot);
  const edges = buildEdges(strategies, ordered, depsDoc);
  const { layers, cycle } = topoLayers(ordered, edges);
  const width = layers.reduce((m, l) => Math.max(m, l.length), 0);
  return { nodes: ordered, edges, layers, width, cycle, epic };
}

function scaffoldDependenciesYaml(projectRoot, epic, { force = false } = {}) {
  const file = dependenciesPath(projectRoot);
  if (fs.existsSync(file) && !force) {
    return { wrote: false, reason: 'exists', file };
  }
  const { ordered } = readStoriesFromStatus(projectRoot, epic);
  if (ordered.length === 0) {
    return { wrote: false, reason: 'no-stories', file };
  }
  const doc = {
    version: 1,
    stories: {},
    overrides: [
      {
        epic: epic || 'unknown',
        force_independent: [],
        force_sequential: [],
      },
    ],
    epics: {},
  };
  // Linear chain by default.
  for (let i = 0; i < ordered.length; i++) {
    doc.stories[ordered[i]] = { depends_on: i === 0 ? [] : [ordered[i - 1]] };
  }
  doc.epics[epic || 'unknown'] = { independent: false };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = [
    '# Sprintpilot dependency sidecar.',
    '# Authoritative input to resolve-dag.js for parallel execution (PR 11+).',
    '# BMad never reads this file — it is Sprintpilot-owned.',
    '#',
    '# Schema:',
    '#   stories.<key>.depends_on: [<key>, ...]   — edges: dep → key',
    '#   overrides[*].force_sequential: [...]     — serialize listed keys',
    '#   overrides[*].force_independent: [...]    — drop inbound edges on listed keys',
    '#   epics.<id>.independent: true             — enable cross-epic parallelism (PR 12)',
    '#',
    '# Safe starting point: a linear chain (below). Uncomment force_independent',
    '# entries to unlock parallel layers.',
    '',
  ].join('\n');
  const body = header + yamlDump(doc) + '\n';
  fs.writeFileSync(file, body);
  return { wrote: true, file };
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2), { booleanFlags: ['force'] });
  if (opts.help || positional.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }
  const command = positional[0];
  if (!VALID_COMMANDS.includes(command)) {
    log.error(`unknown command '${command}'. Valid: ${VALID_COMMANDS.join(', ')}`);
    process.exit(1);
  }
  const projectRoot = opts['project-root'] || process.cwd();
  const epic = opts.epic !== undefined ? String(opts.epic) : null;

  if (command === 'scaffold') {
    if (!epic) {
      log.error('scaffold requires --epic');
      process.exit(1);
    }
    const res = scaffoldDependenciesYaml(projectRoot, epic, { force: opts.force === true });
    if (!res.wrote) {
      log.error(`scaffold: ${res.reason}; use --force to overwrite`);
      process.exit(res.reason === 'exists' ? 2 : 1);
    }
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }

  const strat = parseStrategies(opts.strategy);
  if (!strat.ok) {
    log.error(strat.error);
    process.exit(1);
  }
  const dag = buildDag({ projectRoot, epic, strategies: strat.value });

  if (dag.cycle.length > 0) {
    log.error(`cycle detected: ${dag.cycle.join(', ')}`);
    process.exit(1);
  }

  if (command === 'graph') {
    process.stdout.write(`${JSON.stringify({ nodes: dag.nodes, edges: dag.edges, epic: dag.epic })}\n`);
    return;
  }
  if (command === 'layers') {
    process.stdout.write(`${JSON.stringify(dag.layers)}\n`);
    return;
  }
  if (command === 'width') {
    process.stdout.write(`${dag.width}\n`);
  }
}

module.exports = {
  DEFAULT_STRATEGIES,
  VALID_STRATEGIES,
  VALID_COMMANDS,
  parseEpicFromKey,
  parseStrategies,
  readStoriesFromStatus,
  readDependencies,
  parseDependenciesYaml,
  edgesFromExplicit,
  edgesFromOrdering,
  applyForceIndependent,
  buildEdges,
  topoLayers,
  buildDag,
  scaffoldDependenciesYaml,
  sprintStatusPath,
  dependenciesPath,
};

if (require.main === module) {
  main();
}
