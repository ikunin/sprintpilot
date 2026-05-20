#!/usr/bin/env node

// resolve-dag.js — build the story execution DAG for a sprint.
//
// As of v2.3.0 the authoritative dependency source is sprint-plan.yaml
// (managed by sprint-plan.js). The legacy `_Sprintpilot/sprints/dependencies.yaml`
// file is no longer read — users with that file must run
// `infer-dependencies.js migrate` to copy its content into the new plan.
//
// Usage:
//   resolve-dag.js graph   [--epic <id>] [--project-root <path>] [--strategy <list>]
//   resolve-dag.js layers  [--epic <id>] [--project-root <path>] [--strategy <list>]
//   resolve-dag.js width   [--epic <id>] [--project-root <path>] [--strategy <list>]
//
// Strategies (default order: explicit,ordering):
//   explicit  — read sprint-plan.yaml (dependencies, cross_epic_deps, overrides)
//   ordering  — linear chain from sprint-status.yaml order (safe default)
//   files     — (TODO) infer edges from shared file-path touches
//
// Conflict resolution when multiple strategies contribute: explicit > files > ordering.
// Missing sprint-plan.yaml is fine; we fall back to the next strategy.
//
// Cross-epic edges from `plan.cross_epic_deps` are included only when the
// command runs sprint-wide (no `--epic`). With `--epic <id>` we filter out
// any edge whose `from_story` or `to_story` does not belong to <id>.
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
const { spawnSync } = require('node:child_process');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');
const sprintPlanMod = require('./sprint-plan.js');

const DEFAULT_STRATEGIES = ['explicit', 'ordering'];
const VALID_STRATEGIES = ['explicit', 'ordering', 'files'];
const VALID_COMMANDS = ['graph', 'layers', 'width', 'render'];
const VALID_RENDER_FORMATS = ['mermaid', 'graphviz'];

const { read: readPlan } = sprintPlanMod;

// Mermaid + graphviz color palette per plan_status. Greens/grays/yellows
// chosen for grayscale legibility and adequate color-blind contrast; tests
// also assert the hex values so changes here are intentional.
const STATUS_COLORS = {
  pending: { fill: '#7dd87d', text: '#000' },
  done: { fill: '#888888', text: '#ffffff' },
  skipped: { fill: '#e8e864', text: '#000' },
  excluded: { fill: '#444444', text: '#aaa' },
};

function help() {
  log.out(
    [
      'Usage:',
      '  resolve-dag.js graph   [--epic <id>] [--strategy explicit,ordering]',
      '  resolve-dag.js layers  [--epic <id>] [--strategy explicit,ordering]',
      '  resolve-dag.js width   [--epic <id>] [--strategy explicit,ordering]',
      '  resolve-dag.js render  [--format mermaid|graphviz] [--output <path>] [--epic <id>]',
      '',
      'Strategies: explicit | ordering | files (opt-in, TODO)',
      'Render formats: mermaid (default, GitHub-renderable) | graphviz (requires `dot`)',
      'Default output: _bmad-output/implementation-artifacts/sprint-plan-dag.{mmd,dot}',
      '',
      'Reads sprint-plan.yaml for explicit dependencies. Use',
      '`infer-dependencies.js migrate` if you have a legacy dependencies.yaml.',
    ].join('\n'),
  );
}

// ------------------------------------------------------------------
// Reading stories / dependencies
// ------------------------------------------------------------------

function sprintStatusPath(projectRoot) {
  return path.join(projectRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml');
}

// Legacy path — retained for the one-shot `infer-dependencies.js migrate`
// flow. Reads MUST NOT route here; resolve-dag goes through sprint-plan.yaml.
function dependenciesPath(projectRoot) {
  return path.join(projectRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml');
}

function parseEpicFromKey(storyKey) {
  // Epic id = first hyphen-delimited segment of the story key. BMad's
  // canonical convention is `<epic-num>-<story-num>-<slug>` (e.g.
  // `1-2-user-auth` → epic "1"), but nothing prevents a project from
  // using non-numeric epic identifiers (`auth-1-login`, `infra-bootstrap`).
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

// Read the dependencies section of sprint-plan.yaml. Returns a "depsDoc"
// shape compatible with edgesFromExplicit / applyForceIndependent:
//   { stories: { <key>: { depends_on, rationale } }, overrides, cross_epic_deps }
// Returns null if no plan exists OR the plan is corrupt. The strategy
// layer treats null as "no explicit edges" and falls through to ordering.
function readDependencies(projectRoot) {
  const result = readPlan({ projectRoot });
  if (result === null) return null;
  if (result && typeof result === 'object' && 'error' in result) {
    log.warn(`sprint-plan.yaml unreadable (${result.error}): ${result.message}`);
    return null;
  }
  return {
    stories:
      result.dependencies && typeof result.dependencies.stories === 'object'
        ? result.dependencies.stories
        : {},
    overrides: Array.isArray(result.overrides) ? result.overrides : [],
    cross_epic_deps: Array.isArray(result.cross_epic_deps) ? result.cross_epic_deps : [],
  };
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

// Cross-epic edges live in plan.cross_epic_deps as { from_story, to_story,
// rationale, ... }. Convention: from_story → to_story means "from depends
// on to" (same direction as per-epic depends_on). Edge tuple emitted is
// `[to, from]` so it flows as "to runs before from" in topo order.
function edgesFromCrossEpic(depsDoc, nodes) {
  if (!depsDoc || !Array.isArray(depsDoc.cross_epic_deps)) return [];
  const out = [];
  const nodeSet = new Set(nodes);
  for (const edge of depsDoc.cross_epic_deps) {
    if (!edge) continue;
    const from = edge.from_story;
    const to = edge.to_story;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (!nodeSet.has(from) || !nodeSet.has(to)) continue;
    out.push([to, from]);
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
  // depends on b also run any time".
  return edges.filter(([_a, b]) => !indep.has(b));
}

function buildEdges(strategies, nodes, depsDoc, { includeCrossEpic = false } = {}) {
  // explicit > ordering. Dedupe while preserving priority insertion order.
  const seen = new Set();
  const out = [];
  const pushEdges = (edges) => {
    for (const [a, b] of edges) {
      const key = `${a} ${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([a, b]);
    }
  };
  for (const strat of strategies) {
    if (strat === 'explicit') {
      pushEdges(edgesFromExplicit(depsDoc, nodes));
      if (includeCrossEpic) pushEdges(edgesFromCrossEpic(depsDoc, nodes));
    } else if (strat === 'ordering') {
      pushEdges(edgesFromOrdering(nodes));
    } else if (strat === 'files') {
      // files strategy opt-in, not implemented yet — a future
      // sprintpilot-infer-dependencies skill populates the explicit sidecar.
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
  // Cross-epic edges flow into the graph only when the caller is looking at
  // the whole sprint. Per-epic queries see only intra-epic edges.
  const includeCrossEpic = epic === null;
  const edges = buildEdges(strategies, ordered, depsDoc, { includeCrossEpic });
  const { layers, cycle } = topoLayers(ordered, edges);
  const width = layers.reduce((m, l) => Math.max(m, l.length), 0);
  return { nodes: ordered, edges, layers, width, cycle, epic };
}

// ------------------------------------------------------------------
// Render
// ------------------------------------------------------------------

// Build a node → plan_status map from plan.stories[]. Stories absent from
// the plan default to 'pending' so rendering works even on plans the skill
// hasn't fully populated (Phase 0 — plan.stories is typically []).
function planStatusByKey(plan) {
  const map = new Map();
  if (plan && Array.isArray(plan.stories)) {
    for (const s of plan.stories) {
      if (s && typeof s.key === 'string') {
        const status = ['pending', 'done', 'skipped', 'excluded'].includes(s.plan_status)
          ? s.plan_status
          : 'pending';
        map.set(s.key, status);
      }
    }
  }
  return map;
}

// Build a story_key → issue_id map. Returns only entries with non-empty
// issue_id strings; absent or null values are silently skipped (the
// renderer uses the story key as-is when no entry exists). Lets the
// renderer prefix labels with the tracker ID for at-a-glance
// cross-reference back to Jira / Linear / GitHub / GitLab tickets.
function issueIdByStoryKey(plan) {
  const map = new Map();
  if (plan && Array.isArray(plan.stories)) {
    for (const s of plan.stories) {
      if (s && typeof s.key === 'string' && typeof s.issue_id === 'string' && s.issue_id) {
        map.set(s.key, s.issue_id);
      }
    }
  }
  return map;
}

// Build an epic_id → issue_id map for the epic subgraph labels.
// Epic ids are stored as strings in plan.epics[].id — accept both
// strings and numbers for robustness against hand-edited plans.
function issueIdByEpicId(plan) {
  const map = new Map();
  if (plan && Array.isArray(plan.epics)) {
    for (const e of plan.epics) {
      if (e && (typeof e.id === 'string' || typeof e.id === 'number') &&
          typeof e.issue_id === 'string' && e.issue_id) {
        map.set(String(e.id), e.issue_id);
      }
    }
  }
  return map;
}

// Compose the visual label for a story node. Returns "<issue_id>: <key>"
// when an issue is tracked, otherwise just the key. Pure formatter so
// mermaid + graphviz can share the same convention.
function composeStoryLabel(storyKey, issueIdMap) {
  const issueId = issueIdMap.get(storyKey);
  return issueId ? `${issueId}: ${storyKey}` : storyKey;
}

function composeEpicLabel(epicId, issueIdMap) {
  const issueId = issueIdMap.get(String(epicId));
  return issueId ? `${issueId}: Epic ${epicId}` : `Epic ${epicId}`;
}

// Bucket the resolved edges into intra-epic vs cross-epic. We re-derive
// "is cross-epic" by inspecting node prefixes — the buildEdges output
// loses provenance, so we restitch from epic membership at render time.
function bucketEdges(edges) {
  const intra = [];
  const cross = [];
  for (const [a, b] of edges) {
    const epicA = parseEpicFromKey(a);
    const epicB = parseEpicFromKey(b);
    if (epicA !== null && epicB !== null && epicA !== epicB) cross.push([a, b]);
    else intra.push([a, b]);
  }
  return { intra, cross };
}

// Mermaid escaping: replace characters that would break flowchart syntax.
// We use the [Label] form for node labels which tolerates most characters
// once double-quoted — BUT several characters still break parsing:
//   - `]` `[` `(` `)` `<` `>` — mermaid scans for matching brackets
//   - `|` — link label syntax (A -->|label| B)
//   - `;` — sometimes used as statement separator
//   - `&` — start of HTML entity (avoid raw `&` to keep entities atomic)
//   - newlines — must use `<br>` tag for explicit line break
//   - ASCII control chars (\x00–\x1f) — undefined rendering behavior
//   - Unicode RTL/LRM marks (U+202A–U+202E, U+2066–U+2069, U+061C) —
//     can visually reorder labels in confusing ways
//
// Story keys are pre-validated via STORY_KEY_RE (/^[A-Za-z0-9._-]{1,64}$/)
// so they're already safe; the attack surface is issue_id (free-text
// captured during the planning skill's Step 7) which composeStoryLabel
// concatenates into the label. Escape defensively here so any future
// label source is also safe, AND hand-edited plans don't corrupt
// rendering (defense in depth — setIssueId also validates).
// Single-pass escape map. Each input character is matched ONCE by the
// regex below and replaced with the entity-encoded form. Output
// characters (the entity strings themselves) are never re-processed,
// which avoids the double-encoding trap a multi-pass .replace() chain
// would hit (e.g., `&amp;` → `&amp;amp;` if `&` is escaped twice).
const MERMAID_ESCAPE_MAP = {
  '\\': '&#92;',
  '"': '&quot;',
  '&': '&amp;',
  ';': '&#59;',
  ']': '&#93;',
  '[': '&#91;',
  '(': '&#40;',
  ')': '&#41;',
  '<': '&lt;',
  '>': '&gt;',
  '|': '&#124;',
  '\n': '<br>',
};
const MERMAID_ESCAPE_CHARS = /[\\"&;\]\[()<>|\n]/g;
// ASCII control chars (except \n which we map to <br> above) + DEL.
const STRIP_CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/g;
// Unicode bidi-override / isolate / embedding marks. These can reorder
// the visual presentation of a label in confusing ways even when the
// underlying codepoints are benign — strip them entirely.
const STRIP_BIDI = /[‪-‮⁦-⁩؜]/g;

function mermaidEscapeLabel(s) {
  return (
    String(s)
      // Strip carriage returns first so the \n → <br> mapping below
      // doesn't double-emit <br> on \r\n inputs.
      .replace(/\r/g, '')
      // Single-pass entity-encode of all chars that have mermaid-syntax
      // meaning. The replacement function runs ONCE per matched char;
      // the entity output is opaque to the regex.
      .replace(MERMAID_ESCAPE_CHARS, (c) => MERMAID_ESCAPE_MAP[c])
      .replace(STRIP_CONTROL, '')
      .replace(STRIP_BIDI, '')
  );
}

function renderMermaid(dag, plan) {
  const statusByKey = planStatusByKey(plan);
  const storyIssueIds = issueIdByStoryKey(plan);
  const epicIssueIds = issueIdByEpicId(plan);
  const { intra, cross } = bucketEdges(dag.edges);
  const lines = [];
  lines.push(`%% plan-id: ${plan?.plan_id ?? 'unknown'}`);
  lines.push(`%% generated: ${plan?.generated ?? new Date().toISOString()}`);
  lines.push('%% Sprint plan DAG — node fill encodes plan_status; cross-epic edges are dashed.');
  lines.push('%% Story labels are prefixed with their issue_id when set in plan.stories.');
  lines.push('flowchart LR');

  // Group nodes by epic (if any). When sprint-wide, emit subgraphs.
  const epicGroups = new Map();
  for (const node of dag.nodes) {
    const epic = parseEpicFromKey(node) ?? 'unknown';
    if (!epicGroups.has(epic)) epicGroups.set(epic, []);
    epicGroups.get(epic).push(node);
  }

  const epicsSorted = [...epicGroups.keys()].sort();
  for (const epic of epicsSorted) {
    const epicLabel = composeEpicLabel(epic, epicIssueIds);
    lines.push(`  subgraph epic_${epic} ["${mermaidEscapeLabel(epicLabel)}"]`);
    for (const node of epicGroups.get(epic).sort()) {
      const status = statusByKey.get(node) ?? 'pending';
      const storyLabel = composeStoryLabel(node, storyIssueIds);
      lines.push(`    ${node}["${mermaidEscapeLabel(storyLabel)}"]:::${status}`);
    }
    lines.push('  end');
  }

  // Intra-epic edges first (solid), then cross-epic (dashed with label).
  for (const [a, b] of intra) {
    lines.push(`  ${a} --> ${b}`);
  }
  for (const [a, b] of cross) {
    lines.push(`  ${a} -. cross-epic .-> ${b}`);
  }

  // classDef definitions for plan_status colors. Order matches STATUS_COLORS.
  for (const status of Object.keys(STATUS_COLORS)) {
    const { fill, text } = STATUS_COLORS[status];
    lines.push(`  classDef ${status} fill:${fill},color:${text}`);
  }

  return lines.join('\n') + '\n';
}

// Graphviz (dot) label escaping. Double-quoted labels in dot use
// backslash as the escape character (NOT HTML entities — those only
// apply to `<...>` HTML-like labels, which we don't use). So most
// special chars pass through as literals; we only need to escape `\`
// and `"` plus convert newlines and strip dangerous control chars.
//
// `<` and `>` in a double-quoted label render as literal `<` and `>`
// (no HTML interpretation), so they don't need entity encoding.
function dotEscapeLabel(s) {
  return (
    String(s)
      .replace(/\r/g, '')
      .replace(/[\\"]/g, '\\$&')
      .replace(/\n/g, '\\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      .replace(/[‪-‮⁦-⁩؜]/g, '')
  );
}

function renderGraphviz(dag, plan) {
  const statusByKey = planStatusByKey(plan);
  const storyIssueIds = issueIdByStoryKey(plan);
  const epicIssueIds = issueIdByEpicId(plan);
  const { intra, cross } = bucketEdges(dag.edges);
  const lines = [];
  lines.push('digraph SprintPlan {');
  lines.push(`  // plan-id: ${plan?.plan_id ?? 'unknown'}`);
  lines.push(`  // generated: ${plan?.generated ?? new Date().toISOString()}`);
  lines.push('  // Story labels are prefixed with their issue_id when set in plan.stories.');
  lines.push('  rankdir=LR;');
  lines.push('  node [style=filled, fontname="Helvetica"];');

  const epicGroups = new Map();
  for (const node of dag.nodes) {
    const epic = parseEpicFromKey(node) ?? 'unknown';
    if (!epicGroups.has(epic)) epicGroups.set(epic, []);
    epicGroups.get(epic).push(node);
  }

  const epicsSorted = [...epicGroups.keys()].sort();
  for (const epic of epicsSorted) {
    const epicLabel = composeEpicLabel(epic, epicIssueIds);
    lines.push(`  subgraph cluster_${epic} {`);
    lines.push(`    label="${dotEscapeLabel(epicLabel)}";`);
    for (const node of epicGroups.get(epic).sort()) {
      const status = statusByKey.get(node) ?? 'pending';
      const { fill, text } = STATUS_COLORS[status];
      const storyLabel = composeStoryLabel(node, storyIssueIds);
      // When the visual label differs from the node id (issue_id is set),
      // emit an explicit `label=` attribute. Otherwise dot uses the node id.
      const labelAttr =
        storyLabel === node ? '' : `, label="${dotEscapeLabel(storyLabel)}"`;
      lines.push(
        `    "${dotEscapeLabel(node)}" [fillcolor="${fill}", fontcolor="${text}"${labelAttr}];`,
      );
    }
    lines.push('  }');
  }

  for (const [a, b] of intra) {
    lines.push(`  "${dotEscapeLabel(a)}" -> "${dotEscapeLabel(b)}";`);
  }
  for (const [a, b] of cross) {
    lines.push(
      `  "${dotEscapeLabel(a)}" -> "${dotEscapeLabel(b)}" [style=dashed, label="cross-epic"];`,
    );
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}

// Detect `dot` binary in PATH. Used by graphviz format to decide whether
// to fall back to mermaid (with stderr notice) when the toolchain is
// missing on the user's machine.
function hasGraphvizBinary() {
  try {
    const r = spawnSync('dot', ['-V'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function defaultRenderOutputPath(projectRoot, format) {
  const ext = format === 'graphviz' ? 'dot' : 'mmd';
  return path.join(projectRoot, '_bmad-output', 'implementation-artifacts', `sprint-plan-dag.${ext}`);
}

// Top-level render orchestrator. Returns { wrote, file, format, fallback?, message }.
// Failure modes (missing graphviz, write error) emit warnings to stderr but
// fall back gracefully — render NEVER throws under normal use; the caller
// gets a structured result instead.
function runRender({ projectRoot, epic, format, output }) {
  const requestedFormat = format;
  let effectiveFormat = format;
  let fallbackReason = null;
  if (effectiveFormat === 'graphviz' && !hasGraphvizBinary()) {
    log.warn("graphviz toolchain ('dot') not found in PATH — falling back to mermaid");
    effectiveFormat = 'mermaid';
    fallbackReason = 'graphviz-missing';
  }

  const dag = buildDag({ projectRoot, epic, strategies: DEFAULT_STRATEGIES });
  // Refuse to render on a corrupt or cycle-bearing graph; surface clearly.
  if (dag.cycle.length > 0) {
    return {
      wrote: false,
      reason: 'cycle',
      cycle: dag.cycle,
      message: `cycle detected: ${dag.cycle.join(', ')}`,
    };
  }

  const planResult = readPlan({ projectRoot });
  // readPlan returns null on missing, error obj on parse failure, plan on success.
  let plan = null;
  if (planResult && typeof planResult === 'object' && !('error' in planResult)) {
    plan = planResult;
  }

  const body =
    effectiveFormat === 'graphviz' ? renderGraphviz(dag, plan) : renderMermaid(dag, plan);
  const outputPath = output || defaultRenderOutputPath(projectRoot, effectiveFormat);

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, body);
  } catch (e) {
    log.warn(`render write failed: ${e.message}`);
    return {
      wrote: false,
      reason: 'write_failed',
      message: e.message,
      file: outputPath,
    };
  }

  return {
    wrote: true,
    file: outputPath,
    format: effectiveFormat,
    requested_format: requestedFormat,
    ...(fallbackReason ? { fallback: fallbackReason } : {}),
    nodes: dag.nodes.length,
    edges: dag.edges.length,
  };
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
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

  // The `render` subcommand has its own flag set and result handling.
  if (command === 'render') {
    const format = opts.format || 'mermaid';
    if (!VALID_RENDER_FORMATS.includes(format)) {
      log.error(`unknown format '${format}'. Valid: ${VALID_RENDER_FORMATS.join(', ')}`);
      process.exit(1);
    }
    const result = runRender({
      projectRoot,
      epic,
      format,
      output: opts.output || null,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.wrote ? 0 : 1);
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
    process.stdout.write(
      `${JSON.stringify({ nodes: dag.nodes, edges: dag.edges, epic: dag.epic })}\n`,
    );
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
  VALID_RENDER_FORMATS,
  STATUS_COLORS,
  parseEpicFromKey,
  parseStrategies,
  readStoriesFromStatus,
  readDependencies,
  edgesFromExplicit,
  edgesFromCrossEpic,
  edgesFromOrdering,
  applyForceIndependent,
  buildEdges,
  topoLayers,
  buildDag,
  sprintStatusPath,
  dependenciesPath,
  planStatusByKey,
  issueIdByStoryKey,
  issueIdByEpicId,
  composeStoryLabel,
  composeEpicLabel,
  bucketEdges,
  renderMermaid,
  renderGraphviz,
  hasGraphvizBinary,
  defaultRenderOutputPath,
  runRender,
};

if (require.main === module) {
  main();
}
