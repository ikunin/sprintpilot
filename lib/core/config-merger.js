// config-merger.js — preserve user edits when the installer rewrites
// _Sprintpilot/ on upgrade.
//
// Two strategies, picked per-file in `lib/commands/install.js`:
//
//   mergeYamlConfig(bundledText, userText, keyRenames)
//     For modules/*/config.yaml. Bundled file is freshly copied. We
//     parse both files into flat dot-path → scalar maps, compute the
//     user-customized set (paths whose user value differs from bundled
//     default OR doesn't exist in bundled), and patch each customization
//     back into the bundled text by line-substitution. Bundled inline
//     comments and section structure are preserved verbatim.
//
//   mergeTemplateFile(bundledText, userText)
//     For free-form templates (.md / .txt / .secrets-allowlist) where
//     line-based YAML merging doesn't apply. If user file exists and
//     differs from bundled, keep the user file; the caller writes the
//     bundled version next door as a .bundled sidecar so the user can
//     diff and merge by hand.
//
// Both functions are pure. They never read or write disk; the caller
// (applyUserOwnedFiles in install.js) owns I/O via writeAtomic.

// -----------------------------------------------------------------------------
// YAML scalar/path parsing
// -----------------------------------------------------------------------------

// One non-empty, non-comment line of the form:
//   <indent><key>: [value][ # trailing-comment]
// Captures: indent, key, value-with-optional-trailing-comment.
const KV_RE = /^(?<indent>\s*)(?<key>[A-Za-z_][\w-]*):\s*(?<rest>.*)$/;
const COMMENT_ONLY_RE = /^\s*#/;
const BLANK_RE = /^\s*$/;

function isBlank(line) {
  return BLANK_RE.test(line);
}

function isCommentOnly(line) {
  return COMMENT_ONLY_RE.test(line);
}

// Split a value-and-maybe-trailing-comment chunk (the `rest` capture above)
// into { value, trailing } where `trailing` is everything from the first
// unquoted `#` onward (with its leading whitespace). YAML inline comments
// require whitespace before the `#`, which `KV_RE` already enforces by
// matching the colon-then-whitespace before `rest`.
function splitInlineComment(rest) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      // YAML requires whitespace before `#` for an inline comment.
      if (i === 0 || /\s/.test(rest[i - 1])) {
        return { value: rest.slice(0, i).trimEnd(), trailing: rest.slice(i) };
      }
    }
  }
  return { value: rest.trimEnd(), trailing: '' };
}

// Parse a YAML-ish file into a flat map of dot-paths → string values.
// Lines that don't match `KV_RE` are ignored. Container lines (`key:`
// with empty value followed by deeper-indented children) are tracked
// via an indent stack so dot-paths nest correctly. Throws on malformed
// indentation; the caller catches and falls back to template strategy.
function parseFlat(text) {
  const lines = text.split(/\r?\n/);
  const stack = []; // [{ indent: number, key: string }]
  const out = Object.create(null);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || isCommentOnly(line)) continue;
    const m = line.match(KV_RE);
    if (!m) continue; // list items, multi-line strings, etc. — not in our scope
    const indent = m.groups.indent.length;
    const key = m.groups.key;
    const { value } = splitInlineComment(m.groups.rest);
    // Pop deeper-or-equal scopes off the stack.
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const path = [...stack.map((s) => s.key), key].join('.');
    if (value.length === 0) {
      // Container — push and continue. Don't record an empty scalar.
      stack.push({ indent, key });
    } else {
      out[path] = value;
    }
  }
  return out;
}

// Patch a single scalar value at the given dot-path into the bundled
// text. Returns the new text. If the path can't be found, returns the
// text unchanged (the caller decides whether to append the orphan).
function patchScalarInPlace(text, dotPath, newValue) {
  const targetSegments = dotPath.split('.');
  const lines = text.split(/\r?\n/);
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || isCommentOnly(line)) continue;
    const m = line.match(KV_RE);
    if (!m) continue;
    const indent = m.groups.indent.length;
    const key = m.groups.key;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const currentPath = [...stack.map((s) => s.key), key];
    const isContainer = m.groups.rest.length === 0;
    if (isContainer) {
      stack.push({ indent, key });
      continue;
    }
    if (
      currentPath.length === targetSegments.length &&
      currentPath.every((seg, idx) => seg === targetSegments[idx])
    ) {
      const { trailing } = splitInlineComment(m.groups.rest);
      const sep = trailing ? ' ' : '';
      lines[i] = `${m.groups.indent}${key}: ${newValue}${sep}${trailing}`;
      return lines.join('\n');
    }
  }
  return text; // not found — caller may append as orphan
}

// -----------------------------------------------------------------------------
// Public: mergeYamlConfig
// -----------------------------------------------------------------------------

/**
 * Merge user YAML into freshly-copied bundled YAML, preserving the
 * bundled file's structure and inline comments.
 *
 * @param {string} bundledText - the freshly-copied bundled file contents
 * @param {string} userText - the user's pre-upgrade contents
 * @param {Object<string, string>} keyRenames - { 'old.path': 'new.path' }
 * @returns {{ text: string, preserved: string[], orphans: string[], fallback: boolean }}
 *   text: merged file text to write
 *   preserved: dot-paths whose user value was patched into the bundled text
 *   orphans: dot-paths present only in user (appended as a footer block)
 *   fallback: true if parse failed and we returned bundledText unchanged
 */
function mergeYamlConfig(bundledText, userText, keyRenames = {}) {
  if (typeof bundledText !== 'string' || typeof userText !== 'string') {
    return { text: bundledText || '', preserved: [], orphans: [], fallback: true };
  }
  let bundledMap;
  let userMap;
  try {
    bundledMap = parseFlat(bundledText);
    userMap = parseFlat(userText);
  } catch {
    return { text: bundledText, preserved: [], orphans: [], fallback: true };
  }

  // Apply renames before computing the diff: a user key at `old.path`
  // is treated as if it sat at `new.path`.
  const renamed = Object.create(null);
  for (const [k, v] of Object.entries(userMap)) {
    const remapped = Object.hasOwn(keyRenames, k) ? keyRenames[k] : k;
    renamed[remapped] = v;
  }

  let text = bundledText;
  const preserved = [];
  const orphans = [];

  for (const [path, userValue] of Object.entries(renamed)) {
    const bundledValue = bundledMap[path];
    if (bundledValue === userValue) continue; // no customization
    if (bundledValue === undefined) {
      orphans.push(path);
      continue;
    }
    const next = patchScalarInPlace(text, path, userValue);
    if (next === text) {
      // Path exists in bundled map but couldn't be re-located — treat as
      // orphan rather than silently dropping the user value.
      orphans.push(path);
    } else {
      text = next;
      preserved.push(path);
    }
  }

  if (orphans.length > 0) {
    // Append a clearly-labeled footer so the user notices. These keys had
    // no active line in the freshly-copied bundled file to patch into, so
    // they are NOT currently in effect — the footer is a breadcrumb, not a
    // live setting. Render the orphans as commented NESTED YAML (grouped by
    // their dot-path) so "uncomment and merge into the block above" actually
    // produces valid, effective config. The previous dot-path form
    // (`# a.b.c: v`) was a trap: uncommenting it created a flat dotted key
    // that the resolver never reads.
    const yamlLines = renderOrphanBlock(orphans, renamed);
    const footer = [
      '',
      '# Preserved from prior install — these values were set in your previous',
      '# config, but the new bundled config has no active line at their path,',
      '# so they are NOT currently in effect. To re-apply, uncomment and merge',
      '# the block(s) below into the matching section above:',
      '#',
      ...yamlLines.map((l) => (l.length > 0 ? `# ${l}` : '#')),
      '',
    ].join('\n');
    text = text.endsWith('\n') ? text + footer : text + '\n' + footer;
  }

  return { text, preserved, orphans, fallback: false };
}

// Build a nested object from orphan dot-paths and render it as indented
// YAML lines (2-space steps). Orphans that share a prefix (e.g.
// `autopilot.phase_timeout_minutes.create_story` and `…check_readiness`)
// collapse under their common parent so the footer shows one re-pasteable
// block instead of repeated flat paths. Pure; returns string[] (no leading
// comment markers — the caller comments each line).
function renderOrphanBlock(orphans, values) {
  const tree = Object.create(null);
  for (const p of orphans) {
    const segs = p.split('.');
    let node = tree;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (!node[s] || typeof node[s] !== 'object') node[s] = Object.create(null);
      node = node[s]; // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- tree is Object.create(null); a __proto__ segment becomes a harmless own key and cannot reach Object.prototype
    }
    node[segs[segs.length - 1]] = values[p];
  }
  const lines = [];
  const walk = (node, depth) => {
    const indent = '  '.repeat(depth);
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val !== null && typeof val === 'object') {
        lines.push(`${indent}${key}:`);
        walk(val, depth + 1);
      } else {
        lines.push(`${indent}${key}: ${val}`);
      }
    }
  };
  walk(tree, 0);
  return lines;
}

// -----------------------------------------------------------------------------
// Public: mergeTemplateFile
// -----------------------------------------------------------------------------

/**
 * For free-form template files (.md / .txt / .secrets-allowlist).
 *
 * @param {string} bundledText - freshly-copied bundled contents
 * @param {string|null} userText - user's pre-upgrade contents, or null/undefined if absent
 * @returns {{ kept: 'user' | 'bundled', text: string, sidecar: string | null }}
 *   When kept === 'user', `text` is the user contents and `sidecar` is the
 *   bundled contents (caller writes it as <file>.bundled). When kept ===
 *   'bundled', `text` is the bundled contents and `sidecar` is null.
 */
function mergeTemplateFile(bundledText, userText) {
  const bundled = typeof bundledText === 'string' ? bundledText : '';
  const user = typeof userText === 'string' ? userText : '';
  if (user.length === 0 || user === bundled) {
    return { kept: 'bundled', text: bundled, sidecar: null };
  }
  return { kept: 'user', text: user, sidecar: bundled };
}

module.exports = {
  mergeYamlConfig,
  mergeTemplateFile,
  // Exported for tests only.
  _internals: { parseFlat, patchScalarInPlace, splitInlineComment },
};
