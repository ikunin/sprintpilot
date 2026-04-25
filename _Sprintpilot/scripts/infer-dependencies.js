#!/usr/bin/env node

// infer-dependencies.js — validates an LLM-produced inter-story dependency
// envelope and writes _Sprintpilot/sprints/dependencies.yaml for resolve-dag.
//
// Sprintpilot scripts NEVER call LLMs (architecture rule). The autopilot
// session does the inference inline in a workflow.md action, then pipes the
// resulting JSON envelope into this script via stdin. The script:
//   1. Validates the envelope (schema, unknown keys, self-deps, cross-epic
//      edges, missing rationales, cycles).
//   2. Merges with any existing dependencies.yaml — preserving the user's
//      `overrides:` and `epics:` blocks verbatim if present.
//   3. Writes the file with an `# AUTO-INFERRED` marker header so future
//      runs (and humans) can distinguish auto vs hand-authored content.
//
// Usage:
//   infer-dependencies.js scaffold-prompt --epic <id> [--project-root <path>]
//   infer-dependencies.js dry-run        --epic <id> [--project-root <path>]
//   infer-dependencies.js write          --epic <id> [--project-root <path>] [--force]
//
// Subcommands:
//   scaffold-prompt — emits the literal LLM prompt with file paths
//                     interpolated. Stdout-only; the workflow reads this
//                     and feeds it into the in-conversation reasoning step.
//                     Exit 0 always.
//   dry-run         — accepts LLM JSON via stdin, validates, returns
//                     `{valid, errors, merged_doc, diff}` envelope on
//                     stdout. Exit 0 if valid; 1 otherwise.
//   write           — accepts LLM JSON via stdin, validates, writes the
//                     dependencies.yaml file. Exit 0 on success, 1 on
//                     validation failure, 2 if a hand-authored file
//                     (no marker) exists and --force is not set.
//
// LLM JSON envelope:
//   { "version": 1, "epic": "1",
//     "dependencies": { "<key>": ["<dep-key>", ...], ... },
//     "rationale":   { "<key>": "1-sentence justification", ... } }
//
// Stories with no inbound deps are absent from `dependencies` (distinguishes
// "no deps" from "LLM forgot"). Rationale is required for every key in
// `dependencies` so reviewers can spot hallucinated edges.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const dagMod = require('./resolve-dag.js');
const {
  readStoriesFromStatus,
  parseEpicFromKey,
  parseDependenciesYaml,
  topoLayers,
  dependenciesPath,
  sprintStatusPath,
} = dagMod;

const AUTO_MARKER = '# AUTO-INFERRED — regenerate via infer-dependencies.js';
const VALID_COMMANDS = ['scaffold-prompt', 'dry-run', 'write'];

function help() {
  log.out(
    [
      'Usage:',
      '  infer-dependencies.js scaffold-prompt --epic <id> [--project-root <path>]',
      '  infer-dependencies.js dry-run        --epic <id> [--project-root <path>]',
      '  infer-dependencies.js write          --epic <id> [--project-root <path>] [--force]',
      '',
      'Validates an LLM-produced dependency envelope (read from stdin) and',
      'writes _Sprintpilot/sprints/dependencies.yaml. The autopilot session',
      'is the LLM caller — this script never calls a model itself.',
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
  const depsFile = dependenciesPath(projectRoot);
  const lines = [
    `You are inferring inter-story execution dependencies for epic ${epic}. Your output controls which stories Sprintpilot runs concurrently vs sequentially. Wrong dependencies just over-serialize the sprint (slower, not broken). Wrong independence claims cause merge conflicts in worktrees.`,
    '',
    'READ in order, then output the JSON envelope below:',
    `1. ${ssFile} — the authoritative list of story keys for epic ${epic}. Use ONLY these keys.`,
    `2. ${epicsFile} — story descriptions and Acceptance Criteria.`,
    `3. ${archFile} — component map.`,
    `4. ${depsFile} if present — existing user overrides (you must NOT modify these; the script preserves them).`,
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
    `- Different epics — only edges within epic ${epic} are valid.`,
    '',
    'OUTPUT — exactly one JSON object, no prose, no fences:',
    '',
    `  { "version": 1, "epic": "${epic}", "dependencies": { "<key>": ["<dep-key>", ...], ... }, "rationale": { "<key>": "1 sentence quoting the AC/file/architecture line that justifies it", ... } }`,
    '',
    'Stories with no dependencies: omit them entirely from `dependencies`. Provide `rationale` for every key you DO list.',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------

function validateEnvelope(envelope, { projectRoot, epic }) {
  const errors = [];
  const push = (e) => errors.push(e);

  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    push({ code: 'schema', field: 'root', message: 'envelope must be a JSON object' });
    return { valid: false, errors };
  }
  if (envelope.version !== 1) {
    push({ code: 'schema', field: 'version', message: `expected version === 1, got ${JSON.stringify(envelope.version)}` });
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
    push({ code: 'schema', field: 'dependencies', message: 'must be an object of { storyKey: [depKey, ...] }' });
  }
  if (rationale === undefined || rationale === null || typeof rationale !== 'object' || Array.isArray(rationale)) {
    push({ code: 'schema', field: 'rationale', message: 'must be an object of { storyKey: "string" }' });
  }
  // Stop here on root-level shape failures — the per-key checks below assume valid containers.
  if (errors.length > 0) return { valid: false, errors };

  const { byKey } = readStoriesFromStatus(projectRoot, String(epic));
  const validKeys = new Set(Object.keys(byKey));

  for (const key of Object.keys(deps)) {
    const arr = deps[key];
    if (!Array.isArray(arr)) {
      push({ code: 'schema', field: `dependencies.${key}`, message: 'must be an array of story keys' });
      continue;
    }
    if (!validKeys.has(key)) {
      push({ code: 'unknown-key', key, message: `story "${key}" not present in sprint-status.yaml for epic ${epic}` });
    }
    for (const dep of arr) {
      if (typeof dep !== 'string') {
        push({ code: 'schema', field: `dependencies.${key}[]`, message: `dep entries must be strings, got ${JSON.stringify(dep)}` });
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
          message: `cross-epic edge "${key}" → "${dep}" (epic ${depEpic} ≠ ${epic}) — declare via overrides[*].epics.<id>.independent instead`,
        });
        continue;
      }
      if (!validKeys.has(dep)) {
        push({ code: 'unknown-key', key: dep, message: `dependency "${dep}" of "${key}" not in sprint-status.yaml` });
      }
    }
    // Rationale required for every declared key.
    const r = rationale[key];
    if (typeof r !== 'string' || r.trim() === '') {
      push({ code: 'schema', field: `rationale.${key}`, message: 'rationale required for every key in dependencies (non-empty string)' });
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
      push({ code: 'cycle', nodes: cycle.slice().sort(), message: `cyclic dependency among: ${cycle.slice().sort().join(', ')}` });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------
// Existing-file detection + merge
// ---------------------------------------------------------------

function readExisting(projectRoot) {
  const file = dependenciesPath(projectRoot);
  if (!fs.existsSync(file)) return { exists: false, autoMarker: false, doc: null, raw: null };
  const raw = fs.readFileSync(file, 'utf8');
  const firstNonEmpty = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const autoMarker = firstNonEmpty.trim() === AUTO_MARKER;
  let doc = null;
  try {
    doc = parseDependenciesYaml(raw);
  } catch {
    doc = null;
  }
  return { exists: true, autoMarker, doc, raw };
}

function mergeDoc(envelope, existing) {
  // stories: regenerated entirely from the LLM envelope.
  const stories = {};
  const sortedKeys = Object.keys(envelope.dependencies).sort();
  for (const k of sortedKeys) {
    stories[k] = {
      depends_on: envelope.dependencies[k].slice().sort(),
      rationale: envelope.rationale[k],
    };
  }
  // overrides + epics: preserved from existing if present, else empty defaults.
  const overrides = existing && existing.doc && Array.isArray(existing.doc.overrides) ? existing.doc.overrides : [];
  const epics = existing && existing.doc && existing.doc.epics && typeof existing.doc.epics === 'object' && !Array.isArray(existing.doc.epics)
    ? existing.doc.epics
    : {};
  return { version: 1, stories, overrides, epics };
}

// ---------------------------------------------------------------
// Hash + serialization
// ---------------------------------------------------------------

// Content hash covers the structural fields (deps + overrides + epics).
// Rationale text changes do NOT change the hash — they're for human review.
function contentHash(doc) {
  const stripped = {
    stories: {},
    overrides: doc.overrides ?? [],
    epics: doc.epics ?? {},
  };
  for (const k of Object.keys(doc.stories ?? {}).sort()) {
    stripped.stories[k] = { depends_on: (doc.stories[k].depends_on ?? []).slice().sort() };
  }
  return crypto.createHash('sha256').update(JSON.stringify(stripped)).digest('hex').slice(0, 12);
}

// Serialize a value for inline YAML emission. Strings get JSON quoting when
// they contain reserved characters; arrays use JSON flow form (matches the
// shape parseDependenciesYaml accepts).
function inlineScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  const needsQuote =
    s === '' ||
    /[:#\n\r"'\\]/.test(s) ||
    /^[\s\-?&*!|>%@`]/.test(s) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(s) ||
    /^-?\d/.test(s);
  return needsQuote ? JSON.stringify(s) : s;
}

// Small dedicated serializer for dependencies.yaml. Produces nested block
// YAML that parseDependenciesYaml round-trips. Top-level keys: version,
// stories, overrides, epics.
function renderYaml(doc, hash) {
  const lines = [
    AUTO_MARKER,
    '# DO NOT hand-edit `stories:` directly — it is regenerated on the next',
    '# planning cycle. To pin a relationship, add to `overrides:` instead.',
    `# Hash: ${hash}`,
    '',
    `version: ${doc.version}`,
  ];

  // stories: block-form with sorted keys
  const storyKeys = Object.keys(doc.stories ?? {}).sort();
  if (storyKeys.length === 0) {
    lines.push('stories: {}');
  } else {
    lines.push('stories:');
    for (const k of storyKeys) {
      const entry = doc.stories[k];
      lines.push(`  ${k}:`);
      lines.push(`    depends_on: ${JSON.stringify((entry.depends_on ?? []).slice().sort())}`);
      if (entry.rationale !== undefined) {
        lines.push(`    rationale: ${inlineScalar(entry.rationale)}`);
      }
    }
  }

  // overrides: preserved verbatim from existing doc; emit as block-form list
  // of mappings (each entry is an object with epic/force_independent/etc).
  const overrides = Array.isArray(doc.overrides) ? doc.overrides : [];
  if (overrides.length === 0) {
    lines.push('overrides: []');
  } else {
    lines.push('overrides:');
    for (const ov of overrides) {
      const ovKeys = Object.keys(ov ?? {});
      if (ovKeys.length === 0) {
        lines.push('  - {}');
        continue;
      }
      const first = ovKeys[0];
      const firstVal = ov[first];
      if (Array.isArray(firstVal) || (typeof firstVal !== 'object' || firstVal === null)) {
        lines.push(`  - ${first}: ${inlineScalar(firstVal)}`);
      } else {
        lines.push(`  - ${first}:`);
        for (const sk of Object.keys(firstVal)) lines.push(`      ${sk}: ${inlineScalar(firstVal[sk])}`);
      }
      for (let i = 1; i < ovKeys.length; i++) {
        const k = ovKeys[i];
        const v = ov[k];
        if (Array.isArray(v) || (typeof v !== 'object' || v === null)) {
          lines.push(`    ${k}: ${inlineScalar(v)}`);
        } else {
          lines.push(`    ${k}:`);
          for (const sk of Object.keys(v)) lines.push(`      ${sk}: ${inlineScalar(v[sk])}`);
        }
      }
    }
  }

  // epics: block-form mapping (each id maps to { independent: bool })
  const epicIds = Object.keys(doc.epics ?? {});
  if (epicIds.length === 0) {
    lines.push('epics: {}');
  } else {
    lines.push('epics:');
    for (const id of epicIds.sort()) {
      const e = doc.epics[id];
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        lines.push(`  ${id}: ${inlineScalar(e)}`);
        continue;
      }
      lines.push(`  ${id}:`);
      for (const sk of Object.keys(e)) lines.push(`    ${sk}: ${inlineScalar(e[sk])}`);
    }
  }

  return lines.join('\n') + '\n';
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

function atomicWrite(file, body) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`,
  );
  const fd = fs.openSync(tmp, 'w', 0o644);
  try {
    fs.writeFileSync(fd, body);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync unsupported on some filesystems */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // Skip directory fsync on Windows: fs.openSync(<dir>, 'r') throws there
  // and we have no portable Windows equivalent. NTFS rename is atomic;
  // it's just not flushed to disk on power loss the way POSIX fsync would.
  if (process.platform !== 'win32') {
    try {
      const dfd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      /* directory fsync unsupported on some filesystems */
    }
  }
}

// ---------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------

function diffCounts(prev, next) {
  const prevEdges = new Set();
  for (const k of Object.keys(prev?.stories ?? {})) {
    for (const d of prev.stories[k].depends_on ?? []) prevEdges.add(`${d}→${k}`);
  }
  const nextEdges = new Set();
  for (const k of Object.keys(next?.stories ?? {})) {
    for (const d of next.stories[k].depends_on ?? []) nextEdges.add(`${d}→${k}`);
  }
  let added = 0;
  let removed = 0;
  for (const e of nextEdges) if (!prevEdges.has(e)) added++;
  for (const e of prevEdges) if (!nextEdges.has(e)) removed++;
  return { added, removed };
}

async function runScaffoldPrompt(projectRoot, epic) {
  process.stdout.write(scaffoldPrompt(projectRoot, epic) + '\n');
  return 0;
}

async function runDryRun(projectRoot, epic) {
  const stdin = await readStdin();
  let envelope;
  try {
    envelope = JSON.parse(stdin);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ valid: false, errors: [{ code: 'schema', field: 'root', message: `invalid JSON: ${e.message}` }] }) + '\n',
    );
    return 1;
  }
  const result = validateEnvelope(envelope, { projectRoot, epic });
  if (!result.valid) {
    process.stdout.write(JSON.stringify({ valid: false, errors: result.errors }) + '\n');
    return 1;
  }
  const existing = readExisting(projectRoot);
  const merged = mergeDoc(envelope, existing);
  const diff = diffCounts(existing.doc, merged);
  process.stdout.write(JSON.stringify({ valid: true, errors: [], merged_doc: merged, diff }) + '\n');
  return 0;
}

async function runWrite(projectRoot, epic, { force }) {
  const existing = readExisting(projectRoot);
  if (existing.exists && !existing.autoMarker && !force) {
    process.stdout.write(
      JSON.stringify({
        wrote: false,
        reason: 'existing-hand-authored',
        message:
          'Existing dependencies.yaml was hand-authored (no AUTO-INFERRED marker). Re-run with --force to overwrite, or delete it first.',
        file: dependenciesPath(projectRoot),
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
      JSON.stringify({ valid: false, errors: [{ code: 'schema', field: 'root', message: `invalid JSON: ${e.message}` }] }) + '\n',
    );
    return 1;
  }
  const result = validateEnvelope(envelope, { projectRoot, epic });
  if (!result.valid) {
    process.stdout.write(JSON.stringify({ valid: false, errors: result.errors }) + '\n');
    return 1;
  }

  const merged = mergeDoc(envelope, existing);
  const hash = contentHash(merged);
  const body = renderYaml(merged, hash);
  const file = dependenciesPath(projectRoot);
  atomicWrite(file, body);

  const diff = diffCounts(existing.doc, merged);
  const overridesPreserved = (existing.doc?.overrides?.length ?? 0) > 0;
  process.stdout.write(
    JSON.stringify({
      wrote: true,
      file,
      edges_inferred: Object.values(envelope.dependencies).reduce((n, arr) => n + arr.length, 0),
      edges_added: diff.added,
      edges_removed: diff.removed,
      user_overrides_preserved: overridesPreserved,
      hash,
    }) + '\n',
  );
  return 0;
}

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------

async function main() {
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
  if (!epic) {
    log.error(`${command} requires --epic`);
    process.exit(1);
  }

  try {
    if (command === 'scaffold-prompt') process.exit(await runScaffoldPrompt(projectRoot, epic));
    if (command === 'dry-run') process.exit(await runDryRun(projectRoot, epic));
    if (command === 'write') process.exit(await runWrite(projectRoot, epic, { force: opts.force === true }));
  } catch (e) {
    log.error(`unexpected error: ${e.stack || e.message}`);
    process.exit(1);
  }
}

module.exports = {
  AUTO_MARKER,
  VALID_COMMANDS,
  scaffoldPrompt,
  validateEnvelope,
  readExisting,
  mergeDoc,
  contentHash,
  renderYaml,
  inlineScalar,
  diffCounts,
};

if (require.main === module) {
  main();
}
