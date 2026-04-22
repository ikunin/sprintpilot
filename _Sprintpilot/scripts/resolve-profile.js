#!/usr/bin/env node

// resolve-profile.js — resolve the effective Sprintpilot profile config.
//
// Reads:
//   1. _Sprintpilot/modules/autopilot/config.yaml  → complexity_profile key
//      (missing key → defaults to "medium" with a one-time stderr notice)
//   2. _Sprintpilot/modules/autopilot/profiles/_base.yaml  → base defaults
//      (skipped when the profile has version_pinned set — i.e. legacy)
//   3. _Sprintpilot/modules/autopilot/profiles/<profile>.yaml → overlay
//   4. _Sprintpilot/modules/{autopilot,git,ma}/config.yaml → user overrides
//
// Deep-merge semantics:
//   - leaf values: user override > profile overlay > base > undefined
//   - null user-override is "explicit unset" → fall back to profile default
//   - arrays are replaced wholesale (not concatenated)

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const VALID_PROFILES = ['nano', 'small', 'medium', 'large', 'legacy'];
const DEFAULT_PROFILE = 'medium';

// Narrow YAML parser for the profile YAML shape.
//
// We deliberately avoid requiring js-yaml here because this script runs
// from the user's project after `sprintpilot install` copies it into
// `_Sprintpilot/scripts/` — at that point js-yaml isn't resolvable
// because the user's project doesn't depend on @ikunin/sprintpilot.
//
// Supported shape (all that profile YAMLs need):
//   - top-level scalar keys: `name: nano`, `version_pinned: null`
//   - nested objects up to 3 levels deep
//   - scalar values: string (bare / single-quoted / double-quoted),
//     integer, boolean (true/false), null
//   - comments after `#` (whole-line or trailing)
//   - blank lines
//
// NOT supported (and not needed here): arrays, anchors, flow style,
// multi-line strings, timestamps.
function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (const rawLine of lines) {
    // Strip comments (naively — comment `#` inside a quoted string is not
    // handled, but profile YAMLs never have `#` in string values).
    const hashIdx = rawLine.indexOf('#');
    const line = hashIdx === -1 ? rawLine : rawLine.slice(0, hashIdx);
    if (!line.trim()) continue;

    const indent = line.match(/^( *)/)[1].length;
    const content = line.slice(indent).trimEnd();
    const colon = content.indexOf(':');
    if (colon === -1) continue; // malformed line — skip gracefully

    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();

    // Pop stack until top is a strict parent of this indent level.
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (rest === '') {
      // New nested object.
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
      continue;
    }

    parent[key] = parseScalar(rest);
  }
  return root;
}

function parseScalar(raw) {
  // Quoted strings
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'null' || raw === '~' || raw === '') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

function dumpYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === null) {
      lines.push(`${pad}${key}: null`);
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      lines.push(`${pad}${key}:`);
      const inner = dumpYaml(val, indent + 1);
      if (inner) lines.push(inner);
    } else if (typeof val === 'boolean' || typeof val === 'number') {
      lines.push(`${pad}${key}: ${val}`);
    } else {
      // string — quote only if ambiguous
      const s = String(val);
      const needsQuote = /^(true|false|null|~)$/i.test(s) || /^-?\d/.test(s) || /[:#]/.test(s);
      lines.push(`${pad}${key}: ${needsQuote ? JSON.stringify(s) : s}`);
    }
  }
  return lines.join('\n');
}

const yaml = { load: parseYaml, dump: (obj) => `${dumpYaml(obj)}\n` };

function help() {
  log.out(
    [
      'Usage:',
      '  resolve-profile.js print  [--project-root <path>] [--profile <name>]',
      '  resolve-profile.js get <dotted.key> [--project-root <path>] [--profile <name>]',
      '  resolve-profile.js validate [--project-root <path>] [--profile <name>]',
      '',
      'Profiles: nano, small, medium, large, legacy',
    ].join('\n'),
  );
}

function readYamlFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return yaml.load(raw);
  } catch (e) {
    log.warn(`failed to parse ${filePath}: ${e.message}`);
    return null;
  }
}

// Deep-merge `source` into `target`. Rules:
//   - plain objects: merge key-by-key, recursive
//   - arrays: replace wholesale
//   - other leaves: source wins
// Special rule at caller level: `null` in source is treated as "unset";
// the caller decides whether to propagate that or skip the merge.
function deepMerge(target, source) {
  if (!isPlainObject(source)) return source;
  const out = isPlainObject(target) ? { ...target } : {};
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = out[key];
    if (isPlainObject(sv) && isPlainObject(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Read complexity_profile from the autopilot/config.yaml via regex so the
// file's `{{variable}}` placeholders aren't interpreted as YAML tokens.
// Returns { profile, source } where source is:
//   'config'         — key was present and valid
//   'missing-default' — key absent, fell back to DEFAULT_PROFILE
//   'invalid'        — key present but not in VALID_PROFILES
function readConfiguredProfile(projectRoot) {
  const cfgPath = path.join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml');
  if (!fs.existsSync(cfgPath)) {
    return { profile: DEFAULT_PROFILE, source: 'missing-default' };
  }
  const raw = fs.readFileSync(cfgPath, 'utf8');
  // `complexity_profile: <value>` at the top level (two-space indent under
  // `autopilot:` or flat). Accept either; the canonical v2 shape is under
  // autopilot but a flat install could theoretically write it at root.
  const m = raw.match(/^[ \t]*complexity_profile:[ \t]*["']?([a-zA-Z_-]+)["']?[ \t]*(?:#.*)?$/m);
  if (!m) return { profile: DEFAULT_PROFILE, source: 'missing-default' };
  const value = m[1];
  if (!VALID_PROFILES.includes(value)) {
    return { profile: DEFAULT_PROFILE, source: 'invalid', raw: value };
  }
  return { profile: value, source: 'config' };
}

function resolveProfile(projectRoot, explicitProfile) {
  const profilesDir = path.join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'profiles');

  let profile;
  let source;
  if (explicitProfile) {
    if (!VALID_PROFILES.includes(explicitProfile)) {
      log.error(`unknown profile '${explicitProfile}'. Valid: ${VALID_PROFILES.join(', ')}`);
      process.exit(1);
    }
    profile = explicitProfile;
    source = 'flag';
  } else {
    const read = readConfiguredProfile(projectRoot);
    profile = read.profile;
    source = read.source;
    if (read.source === 'missing-default') {
      // One-time stderr notice — caller may silence by redirecting stderr.
      log.info(
        `complexity_profile not set in autopilot/config.yaml; defaulting to '${DEFAULT_PROFILE}' (matches v1.0.5 behavior).`,
      );
    } else if (read.source === 'invalid') {
      log.warn(
        `complexity_profile '${read.raw}' is not recognized; defaulting to '${DEFAULT_PROFILE}'. Valid: ${VALID_PROFILES.join(', ')}`,
      );
    }
  }

  // Load the named profile. It MUST exist — a missing file is a ship
  // error, not a user error, so fail loudly.
  const profileFile = path.join(profilesDir, `${profile}.yaml`);
  const profileDoc = readYamlFile(profileFile);
  if (profileDoc == null) {
    log.error(`profile file missing or unreadable: ${profileFile}`);
    process.exit(2);
  }

  // Legacy pins everything — skip the _base overlay.
  const baseDoc = profileDoc.version_pinned
    ? {}
    : readYamlFile(path.join(profilesDir, '_base.yaml')) || {};

  // Merge: start with base, overlay profile. Strip the `name` +
  // `version_pinned` fields before overlaying the user config so they
  // don't masquerade as config keys.
  const stripMeta = (doc) => {
    const { name: _n, version_pinned: _v, ...rest } = doc || {};
    return rest;
  };
  let resolved = deepMerge(stripMeta(baseDoc), stripMeta(profileDoc));

  // Overlay user config — autopilot/git/ma module YAMLs.
  for (const moduleName of ['autopilot', 'git', 'ma']) {
    const moduleCfg = path.join(projectRoot, '_Sprintpilot', 'modules', moduleName, 'config.yaml');
    const doc = readYamlFile(moduleCfg);
    if (!doc || !isPlainObject(doc)) continue;
    // User config files are flat: top-level keys are the module's own
    // knobs. Wrap them under the module name for the merge.
    const wrapped = { [moduleName]: doc[moduleName] || doc };
    resolved = deepMerge(resolved, wrapped);
  }

  return {
    profile,
    source,
    resolved,
    version_pinned: profileDoc.version_pinned || null,
  };
}

function getByDottedKey(obj, key) {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts) {
    if (!isPlainObject(cur) || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function main() {
  const argv = process.argv.slice(2);
  const { opts, positional } = parseArgs(argv);

  if (opts.help || positional.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }

  const command = positional[0];
  const projectRoot = opts['project-root'] || process.cwd();
  const explicitProfile = opts.profile;

  if (command === 'print') {
    const { resolved } = resolveProfile(projectRoot, explicitProfile);
    process.stdout.write(yaml.dump(resolved));
    return;
  }

  if (command === 'get') {
    const key = positional[1];
    if (!key) {
      log.error('get requires a dotted key argument');
      process.exit(1);
    }
    const { resolved } = resolveProfile(projectRoot, explicitProfile);
    const value = getByDottedKey(resolved, key);
    if (value === undefined) {
      log.error(`key not found: ${key}`);
      process.exit(1);
    }
    process.stdout.write(
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? `${value}\n`
        : `${JSON.stringify(value)}\n`,
    );
    return;
  }

  if (command === 'validate') {
    // Every profile YAML must exist, parse, and declare a name.
    const profilesDir = path.join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
    const errors = [];
    for (const p of ['_base', ...VALID_PROFILES]) {
      const file = path.join(profilesDir, `${p}.yaml`);
      const doc = readYamlFile(file);
      if (doc == null) {
        errors.push(`missing or unparseable: ${file}`);
        continue;
      }
      if (typeof doc.name !== 'string' || doc.name !== p) {
        errors.push(`${file}: expected name: '${p}'`);
      }
      if (p === 'legacy' && !doc.version_pinned) {
        errors.push(`${file}: legacy profile must set version_pinned`);
      }
    }
    if (errors.length) {
      for (const e of errors) log.error(e);
      process.exit(1);
    }
    log.out('OK');
    return;
  }

  log.error(`unknown command: ${command}`);
  help();
  process.exit(1);
}

module.exports = {
  VALID_PROFILES,
  DEFAULT_PROFILE,
  resolveProfile,
  readConfiguredProfile,
  getByDottedKey,
  deepMerge,
};

if (require.main === module) {
  main();
}
