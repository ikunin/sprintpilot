#!/usr/bin/env node

// infer-dependencies.js — validates an LLM-produced inter-story dependency
// envelope and writes its content into sprint-plan.yaml's
// `dependencies.stories` block (Sprintpilot v2.3.0+).
//
// Sprintpilot scripts NEVER call LLMs (architecture rule). The autopilot
// session does the inference inline in a workflow.md action, then pipes the
// resulting JSON envelope into this script via stdin. The script:
//   1. Validates the envelope (schema, unknown keys, self-deps, cross-epic
//      edges, missing rationales, cycles).
//   2. Reads the existing plan (or bootstraps an empty one) via sprint-plan.js.
//   3. Replaces entries for THIS EPIC's stories inside
//      `plan.dependencies.stories` while leaving other-epic entries,
//      cross_epic_deps, and `overrides:` block intact.
//   4. Writes the plan atomically via sprint-plan.js#write.
//
// Cross-epic edges live in a separate top-level block and are populated by
// the `write-cross-epic` subcommand (added later in Phase 0).
//
// Usage:
//   infer-dependencies.js scaffold-prompt --epic <id> [--project-root <path>]
//   infer-dependencies.js dry-run        --epic <id> [--project-root <path>]
//   infer-dependencies.js write          --epic <id> [--project-root <path>]
//
// Subcommands:
//   scaffold-prompt — emits the literal LLM prompt with file paths
//                     interpolated. Stdout-only; the workflow reads this
//                     and feeds it into the in-conversation reasoning step.
//                     Exit 0 always.
//   dry-run         — accepts LLM JSON via stdin, validates, returns
//                     `{valid, errors, merged_plan, diff}` envelope on
//                     stdout. Exit 0 if valid; 1 otherwise.
//   write           — accepts LLM JSON via stdin, validates, writes the
//                     sprint-plan.yaml file. Exit 0 on success, 1 on
//                     validation failure, 2 on plan file read/corrupt error.
//
// LLM JSON envelope (unchanged from prior versions):
//   { "version": 1, "epic": "1",
//     "dependencies": { "<key>": ["<dep-key>", ...], ... },
//     "rationale":   { "<key>": "1-sentence justification", ... } }
//
// Stories with no inbound deps are absent from `dependencies` (distinguishes
// "no deps" from "LLM forgot"). Rationale is required for every key in
// `dependencies` so reviewers can spot hallucinated edges.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const dagMod = require('./resolve-dag.js');
const timing = require('./log-timing.js');
const sprintPlanMod = require('./sprint-plan.js');

function emitTimingEvent(projectRoot, phase, meta) {
  try {
    if (!timing.isEnabled(projectRoot)) return;
    timing.appendLine(projectRoot, 'sprint', timing.buildEntry('once', 'sprint', phase, meta));
  } catch {
    /* ignore — timing is best-effort */
  }
}
const { readStoriesFromStatus, parseEpicFromKey, topoLayers, sprintStatusPath, dependenciesPath } =
  dagMod;

const { read: readPlan, write: writePlan, emptyPlan, planPath } = sprintPlanMod;

const VALID_COMMANDS = ['scaffold-prompt', 'dry-run', 'write', 'migrate', 'write-cross-epic'];

// Cross-epic rationale length cap. Matches the prompt instruction
// (`≤200 chars`) and is validated server-side so misbehaving LLMs can't
// stuff multi-sentence justifications into the plan.
const CROSS_EPIC_RATIONALE_MAX = 200;

function help() {
  log.out(
    [
      'Usage:',
      '  infer-dependencies.js scaffold-prompt --epic <id> [--project-root <path>]',
      '  infer-dependencies.js scaffold-prompt --cross-epic [--project-root <path>]',
      '  infer-dependencies.js dry-run        --epic <id> [--project-root <path>]',
      '  infer-dependencies.js dry-run        --cross-epic [--project-root <path>]',
      '  infer-dependencies.js write          --epic <id> [--project-root <path>]',
      '  infer-dependencies.js write-cross-epic              [--project-root <path>]',
      '  infer-dependencies.js migrate                       [--project-root <path>]',
      '',
      'Validates an LLM-produced dependency envelope (read from stdin) and',
      'writes the result into sprint-plan.yaml`s `dependencies.stories` block.',
      'The autopilot session is the LLM caller — this script never calls a',
      'model itself.',
      '',
      '--cross-epic mode targets cross-epic dependencies (separate from the',
      'per-epic envelope). The per-epic prompt continues to REJECT cross-epic',
      'edges per its existing constraint set; cross-epic detection is a',
      'distinct prompt + envelope shape.',
      '',
      '`migrate` is a one-shot upgrade path: imports any existing legacy',
      '_Sprintpilot/sprints/dependencies.yaml into sprint-plan.yaml and',
      'archives the old file. Idempotent (no-op when old file absent).',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------
// Prompt scaffolding (stdout for the workflow to feed back to LLM)
// ---------------------------------------------------------------

function scaffoldPrompt(projectRoot, epic) {
  const ssFile = sprintStatusPath(projectRoot);
  const epicsFile = path.join(projectRoot, '_bmad-output', 'planning-artifacts', 'epics.md');
  const archFile = path.join(projectRoot, '_bmad-output', 'planning-artifacts', 'architecture.md');
  const planFile = planPath(projectRoot);
  const lines = [
    `You are inferring inter-story execution dependencies for epic ${epic}. Your output controls which stories Sprintpilot runs concurrently vs sequentially. Wrong dependencies just over-serialize the sprint (slower, not broken). Wrong independence claims cause merge conflicts in worktrees.`,
    '',
    'READ in order, then output the JSON envelope below:',
    `1. ${ssFile} — the authoritative list of story keys for epic ${epic}. Use ONLY these keys.`,
    `2. ${epicsFile} — story descriptions and Acceptance Criteria.`,
    `3. ${archFile} — component map.`,
    `4. ${planFile} if present — the active sprint plan. Inspect the existing dependencies block to avoid reverting prior edits; the script will preserve all other-epic entries and the "overrides:" block.`,
    '',
    'RULES — only emit a dependency edge when ONE of the following is concretely true from the read documents:',
    "- Story B's Acceptance Criteria explicitly reference an artifact (table, endpoint, component, file) that story A creates.",
    "- Both stories modify the same file path (mentioned in either story's tasks/AC) — emit B → A so they serialize.",
    '- Story B\'s description begins with words like "Extend", "Add to", "Build on", or names story A.',
    '- Architecture.md groups the modules involved and the dependency direction is explicit.',
    '',
    'DO NOT emit a dependency for:',
    '- General "comes later in the sprint" ordering preferences.',
    '- Vague thematic similarity ("both touch the user feature").',
    '- Test-only or doc-only relationships.',
    `- Different epics — only edges within epic ${epic} are valid here. Cross-epic edges go through a separate cross-epic inference pass.`,
    '',
    'OUTPUT — exactly one JSON object, no prose, no fences:',
    '',
    `  { "version": 1, "epic": "${epic}", "dependencies": { "<key>": ["<dep-key>", ...], ... }, "rationale": { "<key>": "1 sentence quoting the AC/file/architecture line that justifies it", ... } }`,
    '',
    'Stories with no dependencies: omit them entirely from `dependencies`. Provide `rationale` for every key you DO list.',
  ];
  return lines.join('\n');
}

// Cross-epic prompt — separate from the per-epic scaffold-prompt because
// the per-epic prompt INSTRUCTS the LLM to reject cross-epic edges
// (preserves narrow-scope inference + bounded prompt size). The
// cross-epic prompt asks the complementary question: with per-epic
// dependencies and architecture in hand, which edges cross epic
// boundaries?
function scaffoldCrossEpicPrompt(projectRoot) {
  const ssFile = sprintStatusPath(projectRoot);
  const epicsFile = path.join(projectRoot, '_bmad-output', 'planning-artifacts', 'epics.md');
  const archFile = path.join(projectRoot, '_bmad-output', 'planning-artifacts', 'architecture.md');
  const planFile = planPath(projectRoot);
  const lines = [
    'You are helping infer CROSS-EPIC story dependencies for a Sprintpilot sprint plan.',
    '',
    'READ in order:',
    `1. ${planFile} — already-inferred per-epic edges live in dependencies.stories. Do not duplicate these.`,
    `2. ${ssFile} — authoritative list of story keys (epic prefix = leading hyphen segment).`,
    `3. ${epicsFile} — story descriptions and Acceptance Criteria.`,
    `4. ${archFile} (truncated to ## headings) — component map for spotting cross-module hard deps.`,
    '',
    'QUESTION: Which stories in DIFFERENT epics have a hard execution dependency on a story in another epic?',
    '',
    'Flag ONLY dependencies that would BLOCK correct execution if violated:',
    '- Schema needed before consumer reads from it.',
    '- Shared API contract that one story defines and another consumes.',
    '- Data model needed before downstream story integrates against it.',
    "- Migration/setup story explicitly named as a prerequisite in another story's AC.",
    '',
    'DO NOT flag:',
    '- Weak / soft coupling (sequencing preferences, "would be nice to ship first").',
    '- Edges already present in the per-epic dependency map (would be duplicates).',
    '- Edges within the same epic — those go through the per-epic flow.',
    '- Cosmetic or doc-only relationships.',
    '',
    'OUTPUT — exactly one JSON object, no prose, no fences:',
    '',
    `  { "version": 1, "cross_epic_deps": [ { "from_story": "<key>", "to_story": "<key>", "rationale": "<≤${CROSS_EPIC_RATIONALE_MAX} chars, 1 sentence>" } ] }`,
    '',
    'Constraints (will be validated server-side; bad envelope rejected):',
    '- `from_story` and `to_story` MUST belong to different epics (different leading hyphen segments).',
    '- Both keys MUST appear in sprint-status.yaml.',
    `- Rationale REQUIRED, max ${CROSS_EPIC_RATIONALE_MAX} chars, 1 sentence.`,
    '- Do NOT duplicate edges already in plan.dependencies.stories[*].depends_on.',
    '- Return `cross_epic_deps: []` if none detected.',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------
// Cross-epic validation
// ---------------------------------------------------------------

// Validate a cross-epic envelope against sprint-status.yaml AND the
// already-inferred per-epic dependencies in sprint-plan.yaml.
//   - keys must exist in sprint-status
//   - from/to must be DIFFERENT epics
//   - rationale required, max-length capped
//   - duplicates against per-epic plan edges flagged
//   - cycle in the COMBINED (intra + cross) graph flagged
function validateCrossEpicEnvelope(envelope, { projectRoot, plan }) {
  const errors = [];
  const push = (e) => errors.push(e);

  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    push({ code: 'schema', field: 'root', message: 'envelope must be a JSON object' });
    return { valid: false, errors };
  }
  if (envelope.version !== 1) {
    push({
      code: 'schema',
      field: 'version',
      message: `expected version === 1, got ${JSON.stringify(envelope.version)}`,
    });
  }
  if (!Array.isArray(envelope.cross_epic_deps)) {
    push({
      code: 'schema',
      field: 'cross_epic_deps',
      message: 'must be an array of { from_story, to_story, rationale }',
    });
  }
  if (errors.length > 0) return { valid: false, errors };

  // Read full sprint-status (no epic filter) — cross-epic spans the whole sprint.
  const { byKey } = readStoriesFromStatus(projectRoot, null);
  const validKeys = new Set(Object.keys(byKey));

  // Build the set of edges already inferred per-epic so we can flag duplicates.
  const perEpicEdges = new Set();
  const planStories = plan?.dependencies?.stories ? plan.dependencies.stories : {};
  for (const key of Object.keys(planStories)) {
    const depsList = planStories[key]?.depends_on;
    if (!Array.isArray(depsList)) continue;
    for (const dep of depsList) {
      perEpicEdges.add(`${dep}→${key}`);
    }
  }

  const seenPairs = new Set();
  const crossEdges = []; // for cycle detection later
  for (let i = 0; i < envelope.cross_epic_deps.length; i++) {
    const edge = envelope.cross_epic_deps[i];
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
      push({
        code: 'schema',
        field: `cross_epic_deps[${i}]`,
        message: 'each entry must be an object',
      });
      continue;
    }
    const { from_story, to_story, rationale } = edge;
    if (typeof from_story !== 'string' || from_story.length === 0) {
      push({
        code: 'schema',
        field: `cross_epic_deps[${i}].from_story`,
        message: 'must be a non-empty string',
      });
    }
    if (typeof to_story !== 'string' || to_story.length === 0) {
      push({
        code: 'schema',
        field: `cross_epic_deps[${i}].to_story`,
        message: 'must be a non-empty string',
      });
    }
    if (typeof rationale !== 'string' || rationale.trim() === '') {
      push({
        code: 'schema',
        field: `cross_epic_deps[${i}].rationale`,
        message: 'rationale required (non-empty string)',
      });
    } else if (rationale.length > CROSS_EPIC_RATIONALE_MAX) {
      push({
        code: 'rationale-too-long',
        field: `cross_epic_deps[${i}].rationale`,
        message: `rationale exceeds ${CROSS_EPIC_RATIONALE_MAX} chars (got ${rationale.length})`,
      });
    }
    if (typeof from_story !== 'string' || typeof to_story !== 'string') continue;

    if (!validKeys.has(from_story)) {
      push({
        code: 'unknown-key',
        key: from_story,
        message: `from_story "${from_story}" not in sprint-status.yaml`,
      });
    }
    if (!validKeys.has(to_story)) {
      push({
        code: 'unknown-key',
        key: to_story,
        message: `to_story "${to_story}" not in sprint-status.yaml`,
      });
    }
    if (from_story === to_story) {
      push({
        code: 'self-dep',
        key: from_story,
        message: `from_story and to_story must differ (got both "${from_story}")`,
      });
      continue;
    }
    const fromEpic = parseEpicFromKey(from_story);
    const toEpic = parseEpicFromKey(to_story);
    if (fromEpic !== null && toEpic !== null && fromEpic === toEpic) {
      push({
        code: 'same-epic',
        from: from_story,
        to: to_story,
        message: `cross_epic edge "${from_story}" → "${to_story}" is within epic ${fromEpic} — use the per-epic write subcommand instead`,
      });
      continue;
    }
    const pairKey = `${to_story}→${from_story}`;
    if (seenPairs.has(pairKey)) {
      push({
        code: 'duplicate-in-envelope',
        from: from_story,
        to: to_story,
        message: `duplicate cross-epic edge "${from_story}" → "${to_story}" in envelope`,
      });
      continue;
    }
    seenPairs.add(pairKey);

    // Convention: per-epic depends_on encodes "X depends on Y" as edge Y→X.
    // For cross-epic, from_story depends on to_story → edge to_story → from_story.
    const edgeKey = `${to_story}→${from_story}`;
    if (perEpicEdges.has(edgeKey)) {
      push({
        code: 'duplicate-of-per-epic',
        from: from_story,
        to: to_story,
        message: `edge "${from_story}" depends on "${to_story}" is already in per-epic dependencies`,
      });
      continue;
    }
    crossEdges.push([to_story, from_story]);
  }

  // Cycle check in the COMBINED graph (per-epic + cross-epic).
  if (errors.length === 0) {
    const allKeys = Object.keys(byKey);
    const allEdges = [];
    for (const key of Object.keys(planStories)) {
      const depsList = planStories[key]?.depends_on;
      if (!Array.isArray(depsList)) continue;
      for (const dep of depsList) allEdges.push([dep, key]);
    }
    for (const e of crossEdges) allEdges.push(e);
    const { cycle } = topoLayers(allKeys, allEdges);
    if (cycle.length > 0) {
      push({
        code: 'cycle',
        nodes: cycle.slice().sort(),
        message: `cyclic dependency among: ${cycle.slice().sort().join(', ')} (combined intra + cross-epic graph)`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// Apply a cross-epic envelope to a plan. Replaces plan.cross_epic_deps with
// the new edges, stamping `inferred_at` on each one for the AUTO-INFERRED
// marker semantic (so future runs can distinguish auto vs hand-authored).
function applyCrossEpicToPlan(envelope, plan) {
  const now = new Date().toISOString();
  const next = {
    ...plan,
    cross_epic_deps: envelope.cross_epic_deps.map((e) => ({
      from_story: e.from_story,
      to_story: e.to_story,
      rationale: e.rationale,
      inferred_at: now,
    })),
  };
  return next;
}

// ---------------------------------------------------------------
// Validation (unchanged from prior versions)
// ---------------------------------------------------------------

function validateEnvelope(envelope, { projectRoot, epic }) {
  const errors = [];
  const push = (e) => errors.push(e);

  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    push({ code: 'schema', field: 'root', message: 'envelope must be a JSON object' });
    return { valid: false, errors };
  }
  if (envelope.version !== 1) {
    push({
      code: 'schema',
      field: 'version',
      message: `expected version === 1, got ${JSON.stringify(envelope.version)}`,
    });
  }
  if (typeof envelope.epic !== 'string' || envelope.epic !== String(epic)) {
    push({
      code: 'schema',
      field: 'epic',
      message: `expected epic === "${epic}", got ${JSON.stringify(envelope.epic)}`,
    });
  }
  const deps = envelope.dependencies;
  const rationale = envelope.rationale;
  if (deps === undefined || deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
    push({
      code: 'schema',
      field: 'dependencies',
      message: 'must be an object of { storyKey: [depKey, ...] }',
    });
  }
  if (
    rationale === undefined ||
    rationale === null ||
    typeof rationale !== 'object' ||
    Array.isArray(rationale)
  ) {
    push({
      code: 'schema',
      field: 'rationale',
      message: 'must be an object of { storyKey: "string" }',
    });
  }
  // Stop here on root-level shape failures — the per-key checks below assume valid containers.
  if (errors.length > 0) return { valid: false, errors };

  const { byKey } = readStoriesFromStatus(projectRoot, String(epic));
  const validKeys = new Set(Object.keys(byKey));

  for (const key of Object.keys(deps)) {
    const arr = deps[key];
    if (!Array.isArray(arr)) {
      push({
        code: 'schema',
        field: `dependencies.${key}`,
        message: 'must be an array of story keys',
      });
      continue;
    }
    if (!validKeys.has(key)) {
      push({
        code: 'unknown-key',
        key,
        message: `story "${key}" not present in sprint-status.yaml for epic ${epic}`,
      });
    }
    for (const dep of arr) {
      if (typeof dep !== 'string') {
        push({
          code: 'schema',
          field: `dependencies.${key}[]`,
          message: `dep entries must be strings, got ${JSON.stringify(dep)}`,
        });
        continue;
      }
      if (dep === key) {
        push({ code: 'self-dep', key, message: `story "${key}" cannot depend on itself` });
        continue;
      }
      const depEpic = parseEpicFromKey(dep);
      if (depEpic !== null && depEpic !== String(epic)) {
        push({
          code: 'cross-epic-dep',
          from: key,
          to: dep,
          message: `cross-epic edge "${key}" → "${dep}" (epic ${depEpic} ≠ ${epic}) — declare via the write-cross-epic subcommand instead`,
        });
        continue;
      }
      if (!validKeys.has(dep)) {
        push({
          code: 'unknown-key',
          key: dep,
          message: `dependency "${dep}" of "${key}" not in sprint-status.yaml`,
        });
      }
    }
    // Rationale required for every declared key.
    const r = rationale[key];
    if (typeof r !== 'string' || r.trim() === '') {
      push({
        code: 'schema',
        field: `rationale.${key}`,
        message: 'rationale required for every key in dependencies (non-empty string)',
      });
    }
  }

  for (const k of Object.keys(rationale)) {
    if (!(k in deps)) {
      push({
        code: 'schema',
        field: `rationale.${k}`,
        message: `rationale supplied for "${k}" but it has no entry in dependencies (rationale is for declared edges only)`,
      });
    }
  }

  // Cycle detection — only meaningful if the graph is otherwise well-formed.
  if (errors.length === 0) {
    const allKeys = Object.keys(byKey);
    const edges = [];
    for (const key of Object.keys(deps)) {
      for (const dep of deps[key]) edges.push([dep, key]);
    }
    const { cycle } = topoLayers(allKeys, edges);
    if (cycle.length > 0) {
      push({
        code: 'cycle',
        nodes: cycle.slice().sort(),
        message: `cyclic dependency among: ${cycle.slice().sort().join(', ')}`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------
// Plan read + envelope application
// ---------------------------------------------------------------

// Read the existing sprint-plan.yaml (or report absence / corruption).
// Returns { exists, plan, error?, message? }.
function readExistingPlan(projectRoot) {
  const result = readPlan({ projectRoot });
  if (result === null) {
    return { exists: false, plan: null };
  }
  if (result && typeof result === 'object' && 'error' in result) {
    return {
      exists: true,
      plan: null,
      error: result.error,
      message: result.message,
      ...(result.missing_keys ? { missing_keys: result.missing_keys } : {}),
    };
  }
  return { exists: true, plan: result };
}

// Apply an LLM envelope to a plan, replacing dependency entries for THIS
// EPIC's stories. Other-epic entries, cross_epic_deps, overrides, and the
// `notes:` block are preserved verbatim. Stamps `dependencies.auto_inferred_at`.
function applyEnvelopeToPlan(envelope, plan, { projectRoot, epic }) {
  const { byKey } = readStoriesFromStatus(projectRoot, String(epic));
  const epicKeys = new Set(Object.keys(byKey));

  const prevStories =
    plan.dependencies?.stories && typeof plan.dependencies.stories === 'object'
      ? { ...plan.dependencies.stories }
      : {};

  // Drop existing entries for this epic's stories — the envelope is
  // authoritative for the epic's edges (stories absent from envelope are
  // declared dependency-free).
  for (const k of Object.keys(prevStories)) {
    if (epicKeys.has(k)) delete prevStories[k];
  }

  // Add entries from the envelope (sorted depends_on for determinism).
  for (const k of Object.keys(envelope.dependencies).sort()) {
    prevStories[k] = {
      depends_on: envelope.dependencies[k].slice().sort(),
      rationale: envelope.rationale[k],
    };
  }

  const nextDependencies = {
    ...(plan.dependencies || { version: 1, stories: {} }),
    version: plan.dependencies?.version ?? 1,
    auto_inferred_at: new Date().toISOString(),
    stories: prevStories,
  };

  return {
    ...plan,
    dependencies: nextDependencies,
  };
}

// Count edges added vs removed between two plans, for reporting.
function diffEdges(prev, next) {
  const collectEdges = (plan) => {
    const set = new Set();
    const s = plan?.dependencies?.stories ?? {};
    for (const k of Object.keys(s)) {
      for (const d of s[k].depends_on ?? []) set.add(`${d}→${k}`);
    }
    return set;
  };
  const prevEdges = collectEdges(prev);
  const nextEdges = collectEdges(next);
  let added = 0;
  let removed = 0;
  for (const e of nextEdges) if (!prevEdges.has(e)) added++;
  for (const e of prevEdges) if (!nextEdges.has(e)) removed++;
  return { added, removed };
}

// ---------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------

async function runScaffoldPrompt(projectRoot, epic) {
  process.stdout.write(scaffoldPrompt(projectRoot, epic) + '\n');
  return 0;
}

async function runScaffoldPromptCrossEpic(projectRoot) {
  process.stdout.write(scaffoldCrossEpicPrompt(projectRoot) + '\n');
  return 0;
}

async function runDryRunCrossEpic(projectRoot) {
  const stdin = await readStdin();
  let envelope;
  try {
    envelope = JSON.parse(stdin);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        errors: [{ code: 'schema', field: 'root', message: `invalid JSON: ${e.message}` }],
      }) + '\n',
    );
    return 1;
  }
  const existing = readExistingPlan(projectRoot);
  if (existing.error) {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        errors: [{ code: existing.error, field: 'sprint-plan.yaml', message: existing.message }],
      }) + '\n',
    );
    return 1;
  }
  const basePlan = existing.plan ?? emptyPlan({ source: 'cli' });
  const result = validateCrossEpicEnvelope(envelope, { projectRoot, plan: basePlan });
  if (!result.valid) {
    process.stdout.write(JSON.stringify({ valid: false, errors: result.errors }) + '\n');
    return 1;
  }
  const merged = applyCrossEpicToPlan(envelope, basePlan);
  process.stdout.write(
    JSON.stringify({
      valid: true,
      errors: [],
      merged_plan: merged,
      edges_inferred: envelope.cross_epic_deps.length,
    }) + '\n',
  );
  return 0;
}

async function runWriteCrossEpic(projectRoot) {
  const existing = readExistingPlan(projectRoot);
  if (existing.error) {
    process.stdout.write(
      JSON.stringify({
        wrote: false,
        reason: existing.error,
        message: existing.message,
        file: planPath(projectRoot),
      }) + '\n',
    );
    return 2;
  }

  const stdin = await readStdin();
  let envelope;
  try {
    envelope = JSON.parse(stdin);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        errors: [{ code: 'schema', field: 'root', message: `invalid JSON: ${e.message}` }],
      }) + '\n',
    );
    return 1;
  }

  const basePlan = existing.plan ?? emptyPlan({ source: 'cli' });
  const result = validateCrossEpicEnvelope(envelope, { projectRoot, plan: basePlan });
  if (!result.valid) {
    process.stdout.write(JSON.stringify({ valid: false, errors: result.errors }) + '\n');
    return 1;
  }

  const merged = applyCrossEpicToPlan(envelope, basePlan);
  const file = writePlan(merged, { projectRoot });

  emitTimingEvent(projectRoot, 'planning.infer-cross-epic', {
    edges_inferred: envelope.cross_epic_deps.length,
  });

  process.stdout.write(
    JSON.stringify({
      wrote: true,
      file,
      edges_inferred: envelope.cross_epic_deps.length,
    }) + '\n',
  );
  return 0;
}

async function runDryRun(projectRoot, epic) {
  const stdin = await readStdin();
  let envelope;
  try {
    envelope = JSON.parse(stdin);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        errors: [{ code: 'schema', field: 'root', message: `invalid JSON: ${e.message}` }],
      }) + '\n',
    );
    return 1;
  }
  const result = validateEnvelope(envelope, { projectRoot, epic });
  if (!result.valid) {
    process.stdout.write(JSON.stringify({ valid: false, errors: result.errors }) + '\n');
    return 1;
  }
  const existing = readExistingPlan(projectRoot);
  if (existing.error) {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        errors: [
          {
            code: existing.error,
            field: 'sprint-plan.yaml',
            message: existing.message,
          },
        ],
      }) + '\n',
    );
    return 1;
  }
  const basePlan = existing.plan ?? emptyPlan({ source: 'cli' });
  const merged = applyEnvelopeToPlan(envelope, basePlan, { projectRoot, epic });
  const diff = diffEdges(basePlan, merged);
  process.stdout.write(
    JSON.stringify({ valid: true, errors: [], merged_plan: merged, diff }) + '\n',
  );
  return 0;
}

async function runWrite(projectRoot, epic) {
  const existing = readExistingPlan(projectRoot);
  if (existing.error) {
    process.stdout.write(
      JSON.stringify({
        wrote: false,
        reason: existing.error,
        message: existing.message,
        file: planPath(projectRoot),
      }) + '\n',
    );
    return 2;
  }

  const stdin = await readStdin();
  let envelope;
  try {
    envelope = JSON.parse(stdin);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        errors: [{ code: 'schema', field: 'root', message: `invalid JSON: ${e.message}` }],
      }) + '\n',
    );
    return 1;
  }
  const result = validateEnvelope(envelope, { projectRoot, epic });
  if (!result.valid) {
    process.stdout.write(JSON.stringify({ valid: false, errors: result.errors }) + '\n');
    return 1;
  }

  const basePlan = existing.plan ?? emptyPlan({ source: 'cli' });
  const merged = applyEnvelopeToPlan(envelope, basePlan, { projectRoot, epic });
  const file = writePlan(merged, { projectRoot });

  const diff = diffEdges(basePlan, merged);
  const edgesInferred = Object.values(envelope.dependencies).reduce((n, arr) => n + arr.length, 0);

  emitTimingEvent(projectRoot, 'planning.infer-dependencies', {
    epic: String(epic),
    edges_inferred: edgesInferred,
    edges_added: diff.added,
    edges_removed: diff.removed,
  });

  process.stdout.write(
    JSON.stringify({
      wrote: true,
      file,
      edges_inferred: edgesInferred,
      edges_added: diff.added,
      edges_removed: diff.removed,
    }) + '\n',
  );
  return 0;
}

// ---------------------------------------------------------------
// Migration from legacy `_Sprintpilot/sprints/dependencies.yaml`
// ---------------------------------------------------------------

// Read the old dependencies.yaml format. Returns parsed doc or null on
// missing/corrupt. Old format is standard YAML (js-yaml handles it).
//
// v2.3.0 — also enforces schema version. The legacy format we know how
// to migrate is `version: 1` (or missing `version` key, treated as 1
// per the legacy convention). A `version: 2` or other unknown value
// is rejected: silently merging a future schema would lose fields
// without warning. Caller surfaces the rejection as a clean error.
function readLegacyDependencies(projectRoot) {
  const file = dependenciesPath(projectRoot);
  if (!fs.existsSync(file)) return { exists: false };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { exists: true, error: 'read_failed', message: e.message, file };
  }
  let doc;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    return { exists: true, error: 'parse_error', message: e.message, file };
  }
  // Schema-version gate. `null` / `undefined` is treated as 1 (the legacy
  // default before the field was added). Numeric or string `1` is accepted.
  // Anything else is rejected.
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const v = doc.version;
    const isLegacyV1 = v === undefined || v === null || v === 1 || v === '1';
    if (!isLegacyV1) {
      return {
        exists: true,
        error: 'unsupported_legacy_version',
        message:
          `_Sprintpilot/sprints/dependencies.yaml has version=${JSON.stringify(v)} which this ` +
          `Sprintpilot release does not know how to migrate (expected version=1). ` +
          `Archive the file manually to .archive/ and rebuild via /sprintpilot-plan-sprint.`,
        file,
        legacy_version: v,
      };
    }
  }
  return { exists: true, doc, raw, file };
}

// Merge legacy doc into a plan. Replaces plan.dependencies.stories entirely
// with the legacy stories (no per-epic scoping — migration is all-or-nothing),
// appends legacy overrides to plan.overrides (deduped by epic), and stamps
// auto_inferred_at. The legacy `epics:` block is dropped — its
// `independent: true` semantic doesn't have a v2.3.0 equivalent (it
// belongs to v2.4.0's parallel-execution layer).
function mergeLegacyIntoPlan(legacyDoc, plan) {
  const next = {
    ...plan,
    dependencies: {
      ...(plan.dependencies || {}),
      version: legacyDoc.version || 1,
      stories: { ...(legacyDoc.stories || {}) },
      auto_inferred_at: new Date().toISOString(),
    },
  };

  // overrides: append legacy entries, dedupe by epic field if present.
  const existingOverrides = Array.isArray(plan.overrides) ? plan.overrides.slice() : [];
  const legacyOverrides = Array.isArray(legacyDoc.overrides) ? legacyDoc.overrides : [];
  const seenEpics = new Set();
  for (const ov of existingOverrides) {
    if (ov && typeof ov.epic === 'string') seenEpics.add(ov.epic);
  }
  for (const ov of legacyOverrides) {
    if (ov && typeof ov.epic === 'string' && seenEpics.has(ov.epic)) continue;
    existingOverrides.push(ov);
    if (ov && typeof ov.epic === 'string') seenEpics.add(ov.epic);
  }
  next.overrides = existingOverrides;

  return next;
}

// Archive legacy file to .archive/dependencies.yaml.migrated (project-root
// relative). Existing archives are not overwritten — appends a suffix.
function archiveLegacyFile(legacyFile, projectRoot) {
  const archiveDir = path.join(projectRoot, '.archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  let archivePath = path.join(archiveDir, 'dependencies.yaml.migrated');
  let counter = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = path.join(archiveDir, `dependencies.yaml.migrated.${counter}`);
    counter += 1;
  }
  fs.renameSync(legacyFile, archivePath);
  return archivePath;
}

async function runMigrate(projectRoot) {
  const legacy = readLegacyDependencies(projectRoot);

  if (!legacy.exists) {
    process.stdout.write(JSON.stringify({ migrated: false, reason: 'no_legacy_file' }) + '\n');
    return 0;
  }
  if (legacy.error) {
    process.stdout.write(
      JSON.stringify({
        migrated: false,
        reason: legacy.error,
        message: legacy.message,
        file: legacy.file,
      }) + '\n',
    );
    return 1;
  }

  // Validate legacy doc shape — at minimum it should be an object.
  if (!legacy.doc || typeof legacy.doc !== 'object' || Array.isArray(legacy.doc)) {
    process.stdout.write(
      JSON.stringify({
        migrated: false,
        reason: 'invalid_legacy_shape',
        message: 'legacy dependencies.yaml is not a YAML mapping',
        file: legacy.file,
      }) + '\n',
    );
    return 1;
  }

  // Read or bootstrap sprint-plan.yaml.
  const existing = readExistingPlan(projectRoot);
  if (existing.error) {
    process.stdout.write(
      JSON.stringify({
        migrated: false,
        reason: existing.error,
        message: existing.message,
      }) + '\n',
    );
    return 1;
  }
  const basePlan = existing.plan ?? emptyPlan({ source: 'migrated' });

  // Merge + write.
  const nextPlan = mergeLegacyIntoPlan(legacy.doc, basePlan);
  const planFile = writePlan(nextPlan, { projectRoot });

  // Archive the legacy file. Done LAST so a write-plan failure leaves the
  // legacy file in place for re-tries.
  const archivedPath = archiveLegacyFile(legacy.file, projectRoot);

  const storyCount = Object.keys(legacy.doc.stories || {}).length;
  const overrideCount = Array.isArray(legacy.doc.overrides) ? legacy.doc.overrides.length : 0;
  const droppedEpicsBlock =
    legacy.doc.epics &&
    typeof legacy.doc.epics === 'object' &&
    Object.keys(legacy.doc.epics).length > 0;

  emitTimingEvent(projectRoot, 'planning.migrate-dependencies', {
    stories_imported: storyCount,
    overrides_imported: overrideCount,
    epics_block_dropped: !!droppedEpicsBlock,
  });

  process.stdout.write(
    JSON.stringify({
      migrated: true,
      file: planFile,
      archived: archivedPath,
      stories_imported: storyCount,
      overrides_imported: overrideCount,
      epics_block_dropped: !!droppedEpicsBlock,
      ...(droppedEpicsBlock
        ? {
            warning:
              'Legacy epics: block dropped — its `independent: true` semantic has no v2.3.0 equivalent. Re-configure via v2.4.0 mechanisms when available.',
          }
        : {}),
    }) + '\n',
  );
  return 0;
}

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2), {
    booleanFlags: ['cross-epic'],
  });
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
  const crossEpic = opts['cross-epic'] === true;

  // `migrate` and `write-cross-epic` operate sprint-wide; --cross-epic mode
  // for scaffold-prompt/dry-run also doesn't need --epic. Others require it.
  const needsEpic = !(command === 'migrate' || command === 'write-cross-epic' || crossEpic);
  if (needsEpic && !epic) {
    log.error(`${command} requires --epic (or --cross-epic for sprint-wide mode)`);
    process.exit(1);
  }
  // --cross-epic isn't valid for `write` or `migrate`.
  if (
    crossEpic &&
    (command === 'write' || command === 'migrate' || command === 'write-cross-epic')
  ) {
    log.error(`--cross-epic is not valid for ${command}`);
    process.exit(1);
  }

  try {
    if (command === 'scaffold-prompt') {
      if (crossEpic) process.exit(await runScaffoldPromptCrossEpic(projectRoot));
      else process.exit(await runScaffoldPrompt(projectRoot, epic));
    }
    if (command === 'dry-run') {
      if (crossEpic) process.exit(await runDryRunCrossEpic(projectRoot));
      else process.exit(await runDryRun(projectRoot, epic));
    }
    if (command === 'write') process.exit(await runWrite(projectRoot, epic));
    if (command === 'write-cross-epic') process.exit(await runWriteCrossEpic(projectRoot));
    if (command === 'migrate') process.exit(await runMigrate(projectRoot));
  } catch (e) {
    log.error(`unexpected error: ${e.stack || e.message}`);
    process.exit(1);
  }
}

module.exports = {
  VALID_COMMANDS,
  CROSS_EPIC_RATIONALE_MAX,
  scaffoldPrompt,
  scaffoldCrossEpicPrompt,
  validateEnvelope,
  validateCrossEpicEnvelope,
  applyCrossEpicToPlan,
  readExistingPlan,
  applyEnvelopeToPlan,
  diffEdges,
  readLegacyDependencies,
  mergeLegacyIntoPlan,
  archiveLegacyFile,
};

if (require.main === module) {
  main();
}
