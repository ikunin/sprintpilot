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

// =============================================================================
// autopilot-state.yaml — single-writer; latest last_updated wins outright.
// =============================================================================

function mergeAutopilotState(a, _o, b) {
  if (!a && !b) return '';
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  const ta = unquote(readTopLevelScalar(a, 'last_updated'));
  const tb = unquote(readTopLevelScalar(b, 'last_updated'));
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
  const entries = [];
  let current = null;
  let i = startLine + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('  - ')) {
      if (current) entries.push(current);
      current = { lines: [line] };
      continue;
    }
    if (line === '' || line.startsWith('    ') || line.startsWith('\t')) {
      if (current) current.lines.push(line);
      continue;
    }
    // Non-blank, not indented enough → end of `decisions:` block.
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
  if (a === b) return a;
  const pa = parseDecisionEntries(a);
  const pb = parseDecisionEntries(b);
  if (!pa || !pb) return null;
  const byId = new Map();
  // Insertion preserves first-seen order; we resort below for determinism.
  for (const e of pa.entries) {
    if (!e.id) continue;
    byId.set(e.id, e);
  }
  for (const e of pb.entries) {
    if (!e.id) continue;
    const existing = byId.get(e.id);
    if (!existing) {
      byId.set(e.id, e);
      continue;
    }
    if (compareTs(e.ts, existing.ts) > 0) byId.set(e.id, e);
  }
  const merged = Array.from(byId.values()).sort((x, y) => {
    const c = compareTs(x.ts, y.ts);
    if (c !== 0) return c;
    return String(x.id).localeCompare(String(y.id));
  });
  // Update last_updated to the newer side.
  const tla = unquote(readTopLevelScalar(a, 'last_updated'));
  const tlb = unquote(readTopLevelScalar(b, 'last_updated'));
  let head = a.slice(0, pa.headerEndIdx);
  if (compareTs(tla, tlb) < 0) {
    const rawTlb = readTopLevelScalar(b, 'last_updated');
    head = head.replace(/^last_updated:\s*.*$/m, `last_updated: ${rawTlb}`);
  }
  const tail = a.slice(pa.blockEndIdx);
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
  const stories = [];
  let current = null;
  let i = startLine + 1;
  // Story headers are exactly 2-space-indented, end with `:`.
  const headerRe = /^ {2}([A-Za-z0-9][A-Za-z0-9._-]*):[ \t]*$/;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const hm = line.match(headerRe);
    if (hm) {
      if (current) stories.push(current);
      current = { key: hm[1], lines: [line] };
      continue;
    }
    if (line === '' || line.startsWith('    ') || line.startsWith('\t')) {
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
  if (a === b) return a;
  const pa = parseStoryBlocks(a);
  const pb = parseStoryBlocks(b);
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
  const head = a.slice(0, pa.headerEndIdx);
  const tail = a.slice(pa.blockEndIdx);
  const sorted = Array.from(byKey.values()).sort((x, y) => x.key.localeCompare(y.key));
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
  const childHeader = /^ {2}((?:"[^"]+")|[A-Za-z0-9][A-Za-z0-9._-]*):[ \t]*$/;
  const children = [];
  let current = null;
  let i = startLine + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const ch = line.match(childHeader);
    if (ch) {
      if (current) children.push(current);
      current = {
        key: unquote(ch[1]),
        lines: [line],
      };
      continue;
    }
    if (line === '' || line.startsWith('    ') || line.startsWith('\t')) {
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
    if (rb > ra) byKey.set(c.key, c);
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
  if (a === b) return a;
  let result = a;
  // last_updated: latest wins (preserves quoting from whichever side wins).
  const tla = unquote(readTopLevelScalar(a, 'last_updated'));
  const tlb = unquote(readTopLevelScalar(b, 'last_updated'));
  if (tla !== null || tlb !== null) {
    const aHadLU = readTopLevelScalar(a, 'last_updated') !== null;
    if (compareTs(tla, tlb) < 0) {
      const rawB = readTopLevelScalar(b, 'last_updated');
      if (aHadLU) {
        result = result.replace(/^last_updated:\s*.*$/m, `last_updated: ${rawB}`);
      } else {
        result = `${trimTrailingBlank(result)}\nlast_updated: ${rawB}\n`;
      }
    }
  }
  for (const sectionName of ['epics', 'development_status']) {
    result = mergeSection(result, sectionName, b);
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
