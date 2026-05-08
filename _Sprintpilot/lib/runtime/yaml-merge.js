// Block-based merge primitives for the four BMad state files. Pure JS, no
// external deps so this can be invoked as a git merge driver from inside
// the user's project (where `_Sprintpilot/` ships without node_modules).
//
// Each function takes (a, o, b) — the three sides of a git merge —
// and returns a string (the resolved content) on success, or `null`
// when the inputs are too unfamiliar to merge safely. On null the caller
// must leave conflict markers in place: do no harm.
//
// We do NOT do general YAML parsing. Every function knows the shape of its
// target file and operates with regex over well-known sub-structures. The
// merge base (`o`) is informational; we use last-write-wins / union
// semantics rather than a full 3-way merge because the autopilot writes
// these files monotonically and conflicts are dominated by independent
// appends.

const path = require('node:path');

// BMAD's documented story-status ordering. The driver uses this to take the
// most-progressed status when two sides disagree on a single story key.
const STATUS_ORDER = ['backlog', 'ready-for-dev', 'in-progress', 'review', 'done'];

function statusRank(status) {
  if (typeof status !== 'string') return -1;
  return STATUS_ORDER.indexOf(status.trim());
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquote(s) {
  if (s == null) return s;
  const t = String(s).trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

// Compare two ISO-like timestamps. Missing values sort earlier; unparseable
// strings fall back to lexicographic compare so totally-foreign formats
// still pick a stable winner.
function compareTs(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) && Number.isNaN(tb)) {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (Number.isNaN(ta)) return -1;
  if (Number.isNaN(tb)) return 1;
  if (ta > tb) return 1;
  if (ta < tb) return -1;
  return 0;
}

function readTopLevelScalar(text, key) {
  const re = new RegExp(`^${escapeRegex(key)}:[ \\t]*(.*)$`, 'm');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function trimTrailingBlank(s) {
  return s.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
}

// Normalize input before regex anchors run. Strips a UTF-8 BOM (common on
// Windows-edited files; otherwise the first-line `^header:$` match fails)
// and collapses CRLF / CR line endings to LF (`\r\n` clones break every
// `^…$` anchor with the `m` flag because `\r` isn't whitespace under `^`).
// Without this, every per-file merger returns null on a Windows-cloned
// repo → conflict markers in the user's state file.
function normalizeInput(text) {
  if (text === null || text === undefined) return text;
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// Detect the indent of the first non-blank, indented line after `startLine`.
// Returns the indent length (number of leading whitespace chars) or null
// when no indented child follows. Used to make per-section parsers accept
// any consistent indentation (2-space and 4-space are both valid YAML; the
// regex parsers used to require exactly 2).
function detectChildIndent(lines, startLine) {
  for (let j = startLine + 1; j < lines.length; j++) {
    if (lines[j] === '') continue;
    const m = lines[j].match(/^([ \t]+)\S/);
    if (!m) return null;
    return m[1].length;
  }
  return null;
}

// =============================================================================
// autopilot-state.yaml — single-writer; latest last_updated wins outright.
// =============================================================================

function mergeAutopilotState(a, _o, b) {
  if (!a && !b) return '';
  if (!a) return b;
  if (!b) return a;
  const aN = normalizeInput(a);
  const bN = normalizeInput(b);
  if (aN === bN) return a;
  const ta = unquote(readTopLevelScalar(aN, 'last_updated'));
  const tb = unquote(readTopLevelScalar(bN, 'last_updated'));
  // Ties favor A (current side / "ours") so a re-merge doesn't flip output.
  return compareTs(ta, tb) >= 0 ? a : b;
}

// =============================================================================
// decision-log.yaml — append-only `decisions:` list. Union by id; collisions
// resolved by later `ts`.
// =============================================================================
//
// Shape:
//   # comments
//   last_updated: "..."
//
//   decisions:
//     - id: "1"
//       phase: ...
//       ts: "2026-04-15T12:00:00Z"
//     - id: "2"
//       ...

function parseDecisionEntries(text) {
  const m = text.match(/^decisions:[ \t]*$/m);
  if (!m) return null;
  const startLine = text.slice(0, m.index).split('\n').length - 1;
  const lines = text.split('\n');
  // Detect the indent of the first list item — accepts 2-space, 4-space,
  // or tab indentation. Continuation lines (entry fields) must be indented
  // strictly more than the list-item dash.
  const itemIndent = detectChildIndent(lines, startLine);
  const entries = [];
  let current = null;
  let i = startLine + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      if (current) current.lines.push(line);
      continue;
    }
    const leadingMatch = line.match(/^[ \t]*/);
    const indent = leadingMatch ? leadingMatch[0].length : 0;
    // Back to top level (no indent) → end of decisions: block.
    if (indent === 0) break;
    // List-item header: `- ` at the detected indent.
    const isItemHeader =
      itemIndent !== null &&
      indent === itemIndent &&
      line.slice(itemIndent, itemIndent + 2) === '- ';
    if (isItemHeader) {
      if (current) entries.push(current);
      current = { lines: [line] };
      continue;
    }
    // Continuation line: indented more than the item header.
    if (itemIndent !== null && indent > itemIndent) {
      if (current) current.lines.push(line);
      continue;
    }
    break;
  }
  if (current) entries.push(current);
  return {
    headerEndIdx: indexOfLine(text, startLine + 1), // start of first entry
    blockEndLine: i,
    blockEndIdx: indexOfLine(text, i),
    entries: entries.map((e) => {
      const txt = e.lines.join('\n').replace(/\s+$/, '');
      const idMatch = txt.match(/^\s*-\s*id:\s*(.+?)\s*$/m);
      const tsMatch = txt.match(/^\s+ts:\s*(.+?)\s*$/m);
      return {
        id: idMatch ? unquote(idMatch[1]) : null,
        ts: tsMatch ? unquote(tsMatch[1]) : null,
        text: txt,
      };
    }),
  };
}

// Index of the start of `lineNo` (0-based). If lineNo >= total lines, returns
// text.length so callers can splice safely.
function indexOfLine(text, lineNo) {
  if (lineNo <= 0) return 0;
  let idx = 0;
  let n = 0;
  while (n < lineNo) {
    const next = text.indexOf('\n', idx);
    if (next < 0) return text.length;
    idx = next + 1;
    n++;
  }
  return idx;
}

function mergeDecisionLog(a, _o, b) {
  if (!a) return b || '';
  if (!b) return a;
  const aN = normalizeInput(a);
  const bN = normalizeInput(b);
  if (aN === bN) return a;
  const pa = parseDecisionEntries(aN);
  const pb = parseDecisionEntries(bN);
  if (!pa || !pb) return null;
  // Preserve A's original entry order — re-sorting on every merge would
  // produce a churn diff even when only a single new entry is appended.
  // For B-only entries we sort them by ts amongst themselves and append
  // at the end, so newly-arrived decisions accumulate at the bottom in
  // chronological order (matching how an append-only log naturally grows).
  const orderA = [];
  const byId = new Map();
  for (const e of pa.entries) {
    if (!e.id) continue;
    byId.set(e.id, e);
    orderA.push(e.id);
  }
  const fromBOnly = [];
  for (const e of pb.entries) {
    if (!e.id) continue;
    const existing = byId.get(e.id);
    if (!existing) {
      byId.set(e.id, e);
      fromBOnly.push(e.id);
      continue;
    }
    if (compareTs(e.ts, existing.ts) > 0) byId.set(e.id, e);
  }
  fromBOnly.sort((xId, yId) => {
    const x = byId.get(xId);
    const y = byId.get(yId);
    const c = compareTs(x.ts, y.ts);
    if (c !== 0) return c;
    return String(xId).localeCompare(String(yId));
  });
  const merged = [...orderA, ...fromBOnly].map((id) => byId.get(id));
  // Update last_updated to the newer side.
  const tla = unquote(readTopLevelScalar(aN, 'last_updated'));
  const tlb = unquote(readTopLevelScalar(bN, 'last_updated'));
  let head = aN.slice(0, pa.headerEndIdx);
  if (compareTs(tla, tlb) < 0) {
    const rawTlb = readTopLevelScalar(bN, 'last_updated');
    head = head.replace(/^last_updated:\s*.*$/m, `last_updated: ${rawTlb}`);
  }
  const tail = aN.slice(pa.blockEndIdx);
  const body = merged.map((e) => e.text).join('\n');
  return `${trimTrailingBlank(head)}\n${body}\n${tail.replace(/^\s+/, '')}`.replace(/\s+$/, '\n');
}

// =============================================================================
// git-status.yaml — header + per-story blocks under `stories:`. Union of
// stories. Overlaps resolved by later `last_updated` in the story block.
// =============================================================================

function parseStoryBlocks(text) {
  const m = text.match(/^stories:[ \t]*$/m);
  if (!m) return null;
  const startLine = text.slice(0, m.index).split('\n').length - 1;
  const lines = text.split('\n');
  // Detect story-key indent — accepts 2-space, 4-space, or tab. Field
  // continuations must be indented strictly more.
  const childIndent = detectChildIndent(lines, startLine);
  const stories = [];
  let current = null;
  let i = startLine + 1;
  const headerRe =
    childIndent !== null
      ? new RegExp(`^[ \\t]{${childIndent}}([A-Za-z0-9][A-Za-z0-9._-]*):[ \\t]*$`)
      : null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      if (current) current.lines.push(line);
      continue;
    }
    const indent = (line.match(/^[ \t]*/) || [''])[0].length;
    if (indent === 0) break;
    if (headerRe && indent === childIndent) {
      const hm = line.match(headerRe);
      if (hm) {
        if (current) stories.push(current);
        current = { key: hm[1], lines: [line] };
        continue;
      }
      // Same-indent line that isn't a story header → end of stories: block.
      break;
    }
    if (childIndent !== null && indent > childIndent) {
      if (current) current.lines.push(line);
      continue;
    }
    break;
  }
  if (current) stories.push(current);
  return {
    headerEndIdx: indexOfLine(text, startLine + 1),
    blockEndIdx: indexOfLine(text, i),
    stories: stories.map((s) => {
      const txt = s.lines.join('\n').replace(/\s+$/, '');
      const luMatch = txt.match(/^\s+last_updated:\s*(.+?)\s*$/m);
      return {
        key: s.key,
        lastUpdated: luMatch ? unquote(luMatch[1]) : null,
        text: txt,
      };
    }),
  };
}

function mergeGitStatus(a, _o, b) {
  if (!a) return b || '';
  if (!b) return a;
  const aN = normalizeInput(a);
  const bN = normalizeInput(b);
  if (aN === bN) return a;
  const pa = parseStoryBlocks(aN);
  const pb = parseStoryBlocks(bN);
  if (!pa || !pb) return null;
  const byKey = new Map();
  for (const s of pa.stories) byKey.set(s.key, s);
  for (const s of pb.stories) {
    const existing = byKey.get(s.key);
    if (!existing) {
      byKey.set(s.key, s);
      continue;
    }
    if (compareTs(s.lastUpdated, existing.lastUpdated) > 0) {
      byKey.set(s.key, s);
    }
  }
  const head = aN.slice(0, pa.headerEndIdx);
  const tail = aN.slice(pa.blockEndIdx);
  // Natural-sort so `1-10` lands after `1-2` rather than between `1-1`
  // and `1-2`. localeCompare alone is lexicographic; Intl.Collator with
  // numeric:true preserves visual ordering for the typical
  // `<epic>-<story>-<slug>` shape we see across BMad projects.
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const sorted = Array.from(byKey.values()).sort((x, y) => collator.compare(x.key, y.key));
  const body = sorted.map((s) => s.text).join('\n');
  return `${trimTrailingBlank(head)}\n${body}\n${tail.replace(/^\s+/, '')}`.replace(/\s+$/, '\n');
}

// =============================================================================
// sprint-status.yaml (BMAD-owned) — max status per story; max status per epic.
// =============================================================================
//
// Shape (BMad-method v6):
//   sprint:
//     name: "..."
//   epics:
//     1:
//       status: in-progress
//   development_status:
//     1-1-data-model:
//       status: ready-for-dev
//
// We resolve the two structured sections (`epics:` and `development_status:`)
// by per-key max-status. Other top-level sections take A's verbatim — if
// they differ, the high-level diff stays A (we can't safely 3-way-merge
// arbitrary BMad schema additions).

function parseTopLevelSection(text, sectionName) {
  const re = new RegExp(`^${escapeRegex(sectionName)}:[ \\t]*$`, 'm');
  const m = text.match(re);
  if (!m) return null;
  const startLine = text.slice(0, m.index).split('\n').length - 1;
  const lines = text.split('\n');
  // Detect child indent (accepts 2-space, 4-space, or tab — BMad-method
  // generates 2-space but third-party tooling and editor reformatters
  // happily emit 4-space. The strict 2-space regex used here previously
  // produced zero-children parses → silent section erasure on merge.)
  const childIndent = detectChildIndent(lines, startLine);
  const childHeader =
    childIndent !== null
      ? new RegExp(`^[ \\t]{${childIndent}}((?:"[^"]+")|[A-Za-z0-9][A-Za-z0-9._-]*):[ \\t]*$`)
      : null;
  const children = [];
  let current = null;
  let i = startLine + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      if (current) current.lines.push(line);
      continue;
    }
    const indent = (line.match(/^[ \t]*/) || [''])[0].length;
    if (indent === 0) break;
    if (childHeader && indent === childIndent) {
      const ch = line.match(childHeader);
      if (ch) {
        if (current) children.push(current);
        current = {
          key: unquote(ch[1]),
          lines: [line],
        };
        continue;
      }
      // Same-indent line that isn't a child header → leave the section.
      break;
    }
    if (childIndent !== null && indent > childIndent) {
      if (current) current.lines.push(line);
      continue;
    }
    break;
  }
  if (current) children.push(current);
  return {
    headerStartIdx: m.index,
    headerEndIdx: indexOfLine(text, startLine + 1),
    blockEndIdx: indexOfLine(text, i),
    children: children.map((c) => {
      const txt = c.lines.join('\n').replace(/\s+$/, '');
      const sm = txt.match(/^\s+status:\s*(.+?)\s*$/m);
      return {
        key: c.key,
        status: sm ? unquote(sm[1]) : null,
        text: txt,
      };
    }),
  };
}

function mergeSection(text, sectionName, otherText) {
  const sa = parseTopLevelSection(text, sectionName);
  const sb = parseTopLevelSection(otherText, sectionName);
  if (!sa && !sb) return text;
  if (!sa) {
    // Append B's section at end-of-file.
    const bChunk = otherText.slice(sb.headerStartIdx, sb.blockEndIdx);
    const trimmed = trimTrailingBlank(text);
    return `${trimmed}\n\n${bChunk.replace(/\s+$/, '')}\n`;
  }
  if (!sb) return text;
  const byKey = new Map();
  // Preserve A's order for keys A had; append B-only keys at end.
  const orderA = [];
  const seen = new Set();
  for (const c of sa.children) {
    byKey.set(c.key, c);
    orderA.push(c.key);
    seen.add(c.key);
  }
  for (const c of sb.children) {
    const existing = byKey.get(c.key);
    if (!existing) {
      byKey.set(c.key, c);
      orderA.push(c.key);
      seen.add(c.key);
      continue;
    }
    const ra = statusRank(existing.status);
    const rb = statusRank(c.status);
    // Take B only when BOTH sides have a recognized status AND B is strictly
    // higher. If either side has an unrecognized status (rank -1 — possibly
    // a future BMad value like `blocked` / `paused` / `cancelled`), keep A's
    // entry: silently overwriting an unknown status would lose semantics
    // we don't understand. The conservative default is "ours wins on
    // doubt"; the dev sees the merge happen and can re-review.
    if (ra >= 0 && rb >= 0 && rb > ra) byKey.set(c.key, c);
  }
  // Trailing newline matters: the next section's `^header:$` regex
  // anchor depends on the previous section ending with a newline, so the
  // header line begins after `\n` rather than running on from the prior
  // value. Without this, parseTopLevelSection silently misses the second
  // section and the merge looks like a pass-through.
  const merged = `${[`${sectionName}:`].concat(orderA.map((k) => byKey.get(k).text)).join('\n')}\n`;
  return text.slice(0, sa.headerStartIdx) + merged + text.slice(sa.blockEndIdx);
}

function mergeSprintStatus(a, _o, b) {
  if (!a) return b || '';
  if (!b) return a;
  const aN = normalizeInput(a);
  const bN = normalizeInput(b);
  if (aN === bN) return a;
  let result = aN;
  // last_updated: latest wins (preserves quoting from whichever side wins).
  const tla = unquote(readTopLevelScalar(aN, 'last_updated'));
  const tlb = unquote(readTopLevelScalar(bN, 'last_updated'));
  if (tla !== null || tlb !== null) {
    const aHadLU = readTopLevelScalar(aN, 'last_updated') !== null;
    if (compareTs(tla, tlb) < 0) {
      const rawB = readTopLevelScalar(bN, 'last_updated');
      if (aHadLU) {
        result = result.replace(/^last_updated:\s*.*$/m, `last_updated: ${rawB}`);
      } else {
        result = `${trimTrailingBlank(result)}\nlast_updated: ${rawB}\n`;
      }
    }
  }
  for (const sectionName of ['epics', 'development_status']) {
    result = mergeSection(result, sectionName, bN);
  }
  return `${trimTrailingBlank(result)}\n`;
}

// =============================================================================
// Dispatcher
// =============================================================================

const MERGERS = {
  'sprint-status.yaml': mergeSprintStatus,
  'git-status.yaml': mergeGitStatus,
  'decision-log.yaml': mergeDecisionLog,
  'autopilot-state.yaml': mergeAutopilotState,
};

function mergerForFilename(filename) {
  if (!filename) return null;
  return MERGERS[path.basename(filename)] || null;
}

module.exports = {
  STATUS_ORDER,
  statusRank,
  compareTs,
  unquote,
  mergeAutopilotState,
  mergeDecisionLog,
  mergeGitStatus,
  mergeSprintStatus,
  mergerForFilename,
  parseDecisionEntries,
  parseStoryBlocks,
  parseTopLevelSection,
};
