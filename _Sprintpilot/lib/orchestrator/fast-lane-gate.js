// fast-lane-gate.js — pre-story risk classifier for the quick-dev fast lane.
//
// The fast lane routes LOW-RISK stories through `bmad-quick-dev` (one-shot)
// under a FULL profile (small / medium / large / legacy), while substantial
// stories keep the mandatory 7-step BMad cycle. This module is the
// deterministic, cheap, pre-implementation gate that decides `fast | full`
// for a single story from signals available BEFORE any code is written:
//
//   - Acceptance-Criteria count (the story-size gate). Tasks/Subtasks count
//     is also parsed and exposed on the signals, but reserved — no
//     `max_tasks` knob drives the decision today; AC count is the size proxy.
//   - path allow/deny globs matched against paths the story declares
//   - an explicit per-story tag (`fast_lane: true|false` / `risk: low|high`)
//   - a persisted escalation marker (a story bounced back to `full`)
//
// Design contract (see docs/quick-dev-fast-lane-plan.md):
//   - PURE: no I/O. The CLI reads the story file + config and injects text.
//   - CONSERVATIVE: any uncertainty resolves to `full`. The fast lane is a
//     sanctioned, opt-in, default-OFF relaxation — never an implicit skip.
//   - DENY WINS: a deny-glob match (auth / migrations / secrets / …) forces
//     `full` even against an explicit fast tag. Safety is not overridable
//     from the story file.
//   - ESCALATION IS STICKY: a story recorded in `forcedFull` never fast-lanes
//     again, so a misclassified story that bounced to the full cycle stays
//     full on re-derivation.
//
// The classifier mirrors change-size-classifier.js in spirit (scale process
// to risk) but runs PRE-diff, so it's a sibling, not a reuse: it reads the
// story spec, not a git diff.

'use strict';

const DECISION_FAST = 'fast';
const DECISION_FULL = 'full';

// Convert a glob to an anchored RegExp. Supports the subset the fast-lane
// config needs: `**` (any run of chars incl. `/`), `*` (any run except
// `/`), `?` (single non-`/`). Everything else is matched literally. Kept
// local (no minimatch dep) — the orchestrator ships zero runtime deps into
// the user's project.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` → a globstar spanning whole path segments. Compile with real
        // segment boundaries so `**/auth/**` matches `src/auth/x` but NOT
        // `src/oauth/x` (substring `.*auth` would wrongly match the latter).
        i += 1;
        const followedBySlash = glob[i + 1] === '/';
        if (re.endsWith('/')) {
          // `/**` (or `/**/`) → optional descendant: `docs/**` matches both
          // `docs/x` AND bare `docs`.
          re = `${re.slice(0, -1)}(?:/.*)?`;
          if (followedBySlash) i += 1;
        } else if (followedBySlash) {
          // `**/` (leading, or after a literal) → optional ancestor dirs.
          re += '(?:.*/)?';
          i += 1;
        } else {
          // bare `**`
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

// matchesAnyGlob(path, globs) → boolean. Normalizes a leading `./` and
// backslashes so declared paths compare cleanly against POSIX-style globs.
function matchesAnyGlob(p, globs) {
  if (!p || !Array.isArray(globs) || globs.length === 0) return false;
  const norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  for (const g of globs) {
    if (typeof g !== 'string' || g.length === 0) continue;
    if (globToRegExp(g).test(norm)) return true;
  }
  return false;
}

// countAcceptanceCriteria(text) → int. Finds the AC section (matching the
// same heading tolerance verify.js uses) and counts the list items that
// immediately follow it, stopping at the next heading. Returns 0 when no
// AC section is present.
function countAcceptanceCriteria(text) {
  if (!text) return 0;
  const m = text.match(/#{2,4}\s+(?:Acceptance Criteria|Acceptance criteria|AC)\b[^\n]*\n/i);
  if (!m) return 0;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  let count = 0;
  for (const line of rest.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) break; // next heading ends the section
    if (/^\s*(?:[-*]|\d+[.)])\s+\S/.test(line)) count += 1;
  }
  return count;
}

// countTasks(text) → int. Counts task/subtask checkboxes (`[ ]` / `[x]`)
// under a Tasks/Subtasks section. Counts every checkbox in the file after
// the section heading, which is a fine proxy for story size.
function countTasks(text) {
  if (!text) return 0;
  const m = text.match(/#{2,4}\s+Tasks(?:\s*\/\s*Subtasks)?\b[^\n]*\n/i);
  if (!m) return 0;
  const rest = text.slice(m.index + m[0].length);
  const matches = rest.match(/\[[ xX]\]/g);
  return matches ? matches.length : 0;
}

// extractTag(text) → 'fast' | 'full' | null. Reads an explicit routing
// intent from the story. Recognized (case-insensitive, value-tolerant):
//   fast_lane: true|false          → fast | full
//   risk: low                      → fast
//   risk: high | critical          → full
//   risk: medium                   → null (no opinion; fall to inference)
// A `full`-forcing signal always wins over a `fast`-forcing one so a story
// can never be dragged INTO the fast lane by a stray `risk: low` when it
// also declares `risk: high`.
function extractTag(text) {
  if (!text) return null;
  let sawFast = false;
  let sawFull = false;
  // Scan ALL occurrences (not just the first) so a later full-forcing tag
  // isn't masked by an earlier fast one — `full` always wins.
  const fastLaneRe = /(?:^|\n)[ \t]*(?:[-*][ \t]*)?fast[_-]?lane[ \t]*[:=][ \t]*(true|false|yes|no|on|off)/gi;
  let m = fastLaneRe.exec(text);
  while (m) {
    if (/^(true|yes|on)$/i.test(m[1])) sawFast = true;
    else sawFull = true;
    m = fastLaneRe.exec(text);
  }
  const riskRe = /(?:^|\n)[ \t]*(?:[-*][ \t]*)?risk[ \t]*[:=][ \t]*(low|medium|high|critical)/gi;
  let r = riskRe.exec(text);
  while (r) {
    if (/^low$/i.test(r[1])) sawFast = true;
    else if (/^(high|critical)$/i.test(r[1])) sawFull = true;
    r = riskRe.exec(text);
  }
  if (sawFull) return DECISION_FULL;
  if (sawFast) return DECISION_FAST;
  return null;
}

// tagFromFields(obj) → 'fast' | 'full' | null. The structured analogue of
// extractTag, for a sprint-plan.yaml story/epic entry that carries an
// explicit `fast_lane` (bool/string) and/or `risk` (string) field. Used to
// honor epic-level (and plan-level per-story) routing tags — story-FILE tags
// still win over these (resolved in the caller). `full` beats `fast`.
function tagFromFields(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let sawFast = false;
  let sawFull = false;
  const fl = obj.fast_lane;
  if (fl === true || /^(true|yes|on|fast)$/i.test(String(fl))) sawFast = true;
  else if (fl === false || /^(false|no|off|full)$/i.test(String(fl))) sawFull = true;
  const risk = typeof obj.risk === 'string' ? obj.risk.trim().toLowerCase() : null;
  if (risk === 'low') sawFast = true;
  else if (risk === 'high' || risk === 'critical') sawFull = true;
  if (sawFull) return DECISION_FULL;
  if (sawFast) return DECISION_FAST;
  return null;
}

// extractDeclaredPaths(text) → string[]. Best-effort, conservative harvest
// of file paths the story says it will touch. Two sources:
//   1. inline code spans (`src/foo.ts`) that look like paths
//   2. list items under a "File List" / "Files" / "Affected Files" heading
// A "path-like" token contains a `/` or ends in a common source extension.
// Conservative by design: we only fast-lane when EVERY declared path is
// allow-listed, so under-collecting paths costs a fast-lane opportunity
// (safe) while over-collecting can only surface a deny match (also safe).
function extractDeclaredPaths(text) {
  if (!text) return [];
  const paths = new Set();
  // Path-like ⇔ contains a `/` OR ends in a real file extension (≥2 chars,
  // alpha-led — so `e.g.` / `i.e.` in prose don't get mistaken for files).
  const looksLikePath = (t) =>
    /[\w.-]+\/[\w./-]+/.test(t) || /\.[a-z][a-z0-9]{1,4}$/i.test(t.trim());

  // 1. inline code spans
  const spanRe = /`([^`\n]+)`/g;
  let mm = spanRe.exec(text);
  while (mm) {
    const tok = mm[1].trim();
    if (tok && !/\s/.test(tok) && looksLikePath(tok)) paths.add(tok.replace(/[.,;:]$/, ''));
    mm = spanRe.exec(text);
  }

  // 2. list items under a File-List-style heading. Broad synonym set so more
  // BMad story shapes get their declared paths harvested (still conservative —
  // a token must look like a path to count). Accepts `-`/`*`/numbered items.
  const headingRe =
    /#{2,4}\s+(?:File List|Files|Affected Files|Modified Files|Files Modified|Relevant Files|Source Tree|Files? to (?:touch|change|modify|create))\b[^\n]*\n/i;
  const hm = text.match(headingRe);
  if (hm) {
    const rest = text.slice(hm.index + hm[0].length);
    for (const line of rest.split(/\r?\n/)) {
      if (/^#{1,6}\s/.test(line)) break;
      const li = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
      if (li) {
        const tok = li[1].replace(/`/g, '').split(/\s+/)[0].replace(/[.,;:]$/, '');
        if (tok && looksLikePath(tok)) paths.add(tok);
      }
    }
  }
  return Array.from(paths);
}

// extractStorySignals(text) → { acCount, taskCount, tag, declaredPaths }.
// Pure parse of a story markdown file into the numeric/categorical signals
// the gate reasons over. Split from the decision so tests can drive the
// decision with hand-built signals and drive the parser independently.
function extractStorySignals(text) {
  return {
    acCount: countAcceptanceCriteria(text),
    taskCount: countTasks(text),
    tag: extractTag(text),
    declaredPaths: extractDeclaredPaths(text),
  };
}

// normalizeConfig(config) → resolved fast-lane knobs with defaults. Accepts
// either the flat profile fields (fast_lane_enabled, …) or a nested
// { enabled, max_ac, … } object, so callers can pass a typed Profile
// directly.
function normalizeConfig(config) {
  const c = config || {};
  const pick = (flat, nested, fallback) => {
    if (c[flat] !== undefined && c[flat] !== null) return c[flat];
    if (c.fast_lane && c.fast_lane[nested] !== undefined && c.fast_lane[nested] !== null) {
      return c.fast_lane[nested];
    }
    return fallback;
  };
  // max_ac: a non-negative integer. A negative / non-finite value (config
  // typo) would silently force EVERY story full (acCount > -1 is always true),
  // quietly disabling the lane — fall back to the default instead.
  const rawMaxAc = pick('fast_lane_max_ac', 'max_ac', 3);
  const maxAc = Number.isFinite(rawMaxAc) && rawMaxAc >= 0 ? rawMaxAc : 3;
  return {
    enabled: pick('fast_lane_enabled', 'enabled', false) === true,
    maxAc,
    allowGlobs: Array.isArray(pick('fast_lane_allow_globs', 'allow_globs', null))
      ? pick('fast_lane_allow_globs', 'allow_globs', null)
      : [],
    denyGlobs: Array.isArray(pick('fast_lane_deny_globs', 'deny_globs', null))
      ? pick('fast_lane_deny_globs', 'deny_globs', null)
      : [],
    requireStoryTag: pick('fast_lane_require_story_tag', 'require_story_tag', false) === true,
  };
}

// evaluateSignals(signals, config, opts) → { decision, reasons }.
// The pure decision core. Precedence (first match wins):
//   0. forcedFull marker            → full   (sticky escalation)
//   1. fast lane disabled           → full
//   2. explicit full-forcing tag    → full
//   3. deny-glob match              → full   (hard safety; beats fast tag)
//   4. AC count over budget         → full   (size gate; beats fast tag too —
//                                              a `risk: low` line can't wave a
//                                              large story into the fast lane)
//   5. explicit fast-forcing tag    → fast
//   6. require_story_tag & untagged → full
//   7. inferred low-risk            → fast   (declared paths ⊆ allow globs)
//   8. default                      → full   (uncertainty)
//
// Tag resolution: the story-FILE tag (`s.tag`) wins; when it is null, an
// `opts.fallbackTag` (an epic-level / plan-entry tag, derived by the caller
// from sprint-plan.yaml) applies. This lets an epic tagged `risk: low` /
// `fast_lane: true` cascade to its stories without tagging each one.
function evaluateSignals(signals, config, opts = {}) {
  const s = signals || {};
  const cfg = normalizeConfig(config);
  const reasons = [];

  if (opts.forcedFull) {
    return { decision: DECISION_FULL, reasons: ['escalated_forced_full'] };
  }
  if (!cfg.enabled) {
    return { decision: DECISION_FULL, reasons: ['fast_lane_disabled'] };
  }

  const paths = Array.isArray(s.declaredPaths) ? s.declaredPaths : [];
  // Resolved routing tag: story-file wins, else the epic/plan fallback tag.
  const tag = s.tag || opts.fallbackTag || null;
  const tagSuffix = s.tag ? '' : opts.fallbackTag ? ':epic' : '';

  if (tag === DECISION_FULL) {
    return { decision: DECISION_FULL, reasons: [`tag_force_full${tagSuffix}`] };
  }

  const denied = paths.filter((p) => matchesAnyGlob(p, cfg.denyGlobs));
  if (denied.length > 0) {
    return { decision: DECISION_FULL, reasons: [`deny_glob:${denied.join(',')}`] };
  }

  // Size gate runs BEFORE the fast-tag override so an explicit `fast_lane:
  // true` / `risk: low` can only fast-lane a genuinely small story. A story
  // with more ACs than the budget is contradictory-if-tagged → keep it full.
  const acCount = Number.isFinite(s.acCount) ? s.acCount : 0;
  if (acCount > cfg.maxAc) {
    return { decision: DECISION_FULL, reasons: [`ac_count_${acCount}>${cfg.maxAc}`] };
  }

  if (tag === DECISION_FAST) {
    // An epic/plan FALLBACK fast tag does NOT satisfy `require_story_tag` —
    // that knob means "only stories that tag THEMSELVES fast-lane." So when
    // required and the fast tag came from the epic (not the story file), fall
    // through to the require_story_tag_unset gate below. A story-FILE fast tag
    // (and any full-forcing tag, handled above) is unaffected.
    const fromEpic = !s.tag && !!opts.fallbackTag;
    if (!(fromEpic && cfg.requireStoryTag)) {
      return { decision: DECISION_FAST, reasons: [`tag_force_fast${tagSuffix}`] };
    }
  }

  if (cfg.requireStoryTag) {
    return { decision: DECISION_FULL, reasons: ['require_story_tag_unset'] };
  }

  // Inference: only fast-lane when the story positively declares the files
  // it touches AND every one is allow-listed. No declared paths → we can't
  // confirm the blast radius → full.
  if (paths.length > 0 && cfg.allowGlobs.length > 0) {
    const allAllowed = paths.every((p) => matchesAnyGlob(p, cfg.allowGlobs));
    if (allAllowed) {
      reasons.push(`inferred_low_risk(ac=${acCount},paths=${paths.length})`);
      return { decision: DECISION_FAST, reasons };
    }
    const outside = paths.filter((p) => !matchesAnyGlob(p, cfg.allowGlobs));
    return { decision: DECISION_FULL, reasons: [`paths_outside_allow:${outside.join(',')}`] };
  }

  return { decision: DECISION_FULL, reasons: ['default_full_no_allowlisted_paths'] };
}

// classifyStory({ storyKey, storyText, config, forcedFull }) → decision.
// The public entry point the CLI calls. Returns:
//   { story_key, decision: 'fast'|'full', reasons: string[] }
// opts.fallbackTag ('fast'|'full'|null) is the epic/plan-level routing tag the
// caller resolved from sprint-plan.yaml — applied only when the story file
// carries no tag of its own.
function classifyStory({
  storyKey = null,
  storyText = '',
  config,
  forcedFull = false,
  fallbackTag = null,
} = {}) {
  const signals = extractStorySignals(storyText || '');
  const { decision, reasons } = evaluateSignals(signals, config, { forcedFull, fallbackTag });
  return { story_key: storyKey, decision, reasons };
}

module.exports = {
  DECISION_FAST,
  DECISION_FULL,
  globToRegExp,
  matchesAnyGlob,
  countAcceptanceCriteria,
  countTasks,
  extractTag,
  tagFromFields,
  extractDeclaredPaths,
  extractStorySignals,
  normalizeConfig,
  evaluateSignals,
  classifyStory,
};
