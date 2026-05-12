// verify.js — per-action verification table. Trust boundary on `success`.
//
// The LLM may claim success that isn't actually true (test file not written,
// AC not satisfied, etc.). verify.js inspects the world (filesystem +
// optional process exit codes from a runner callback) and decides if the
// `success` is structurally plausible.
//
// Returns { ok: boolean, issues: string[] }.
//
// All filesystem access goes through an injected `fs` so tests can pass a
// mock filesystem. Process invocation (running a test command) goes through
// an injected `runner` callback so the orchestrator can choose how to
// dispatch (synchronous spawn, async batch, etc.).
//
// `verify.js` is the structural complement to `adapt.js`:
//   - adapt.js: how to react to a signal
//   - verify.js: is the signal's claim plausible against the world

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { STATES } = require('./state-machine');

function fileExists(fs, path) {
  try {
    fs.accessSync(path, fs.constants ? fs.constants.F_OK : 0);
    return true;
  } catch (_e) {
    return false;
  }
}

function readFileSafe(fs, path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (_e) {
    return null;
  }
}

function isNonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

function frontMatter(text) {
  if (!text) return null;
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Extract a story's status from sprint-status.yaml without pulling in a
// full YAML parser. Supports both inline form (`<key>: <status>`) and
// block form (`<key>:\n  status: <status>\n  title: ...`).
function storyStatusFromSprintStatus(text, storyKey) {
  if (!text || !storyKey) return null;
  const k = escapeRe(storyKey);
  // Block form first — has a `status:` line inside the indented block.
  const blockRe = new RegExp(`^(\\s+)${k}:\\s*\\n((?:\\1\\s+[^\\n]+\\n)+)`, 'm');
  const bm = text.match(blockRe);
  if (bm) {
    const inner = bm[2];
    const sm = inner.match(/^\s+status:\s*["']?([\w-]+)["']?/m);
    if (sm) return sm[1];
  }
  // Inline form: `  story-key: done` (status as scalar value).
  const inlineRe = new RegExp(`^\\s+${k}:\\s*["']?([\\w-]+)["']?\\s*$`, 'm');
  const im = text.match(inlineRe);
  return im ? im[1] : null;
}

function readSprintStatus(fs, projectRoot) {
  const p = nodePath.join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'sprint-status.yaml',
  );
  return readFileSafe(fs, p);
}

// Per-phase verifiers. Each receives (state, signalOutput, context) and
// returns { ok, issues[] }. `context` carries injected dependencies.
const VERIFIERS = {
  [STATES.CREATE_STORY]: verifyCreateStory,
  [STATES.CHECK_READINESS]: verifyCheckReadiness,
  [STATES.DEV_RED]: verifyDevRed,
  [STATES.DEV_GREEN]: verifyDevGreen,
  [STATES.CODE_REVIEW]: verifyCodeReview,
  [STATES.PATCH_APPLY]: verifyPatchApply,
  [STATES.PATCH_RETEST]: verifyPatchRetest,
  [STATES.STORY_DONE]: verifyStoryDone,
  [STATES.EPIC_BOUNDARY_CHECK]: verifyEpicBoundary,
  [STATES.RETROSPECTIVE]: verifyRetrospective,
  [STATES.NANO_QUICK_DEV]: verifyNanoQuickDev,
};

function verify(state, signalOutput, context) {
  if (!state || !state.phase) return { ok: false, issues: ['state.phase missing'] };
  const fn = VERIFIERS[state.phase];
  if (!fn) return { ok: true, issues: [] }; // unknown phase: defer to state machine
  const ctx = {
    fs: (context && context.fs) || nodeFs,
    runner: (context && context.runner) || null,
    projectRoot: (context && context.projectRoot) || '.',
    augmented: (context && context.augmented) || null,
  };
  try {
    return fn(state, signalOutput || {}, ctx);
  } catch (e) {
    return { ok: false, issues: [`verifier threw: ${e.message}`] };
  }
}

function verifyCreateStory(state, _out, ctx) {
  const issues = [];
  if (!state.story_file_path) issues.push('story_file_path not set');
  else if (!fileExists(ctx.fs, state.story_file_path))
    issues.push(`story file missing: ${state.story_file_path}`);
  else {
    const text = readFileSafe(ctx.fs, state.story_file_path);
    const fm = frontMatter(text);
    if (!fm) issues.push('story file missing YAML front-matter');
    // AC presence — look for "## Acceptance Criteria" section with at least one bullet.
    if (text && !/##\s+Acceptance Criteria[\s\S]*?\n-\s+/.test(text)) {
      issues.push('Acceptance Criteria section missing or empty');
    }
    // Tasks/Subtasks section with at least one task checkbox — required by
    // BMad bookkeeping. `bmad-create-story` produces unchecked `[ ]`
    // entries; `bmad-dev-story` flips them to `[x]`. If neither is present,
    // dev-story will have nothing to check off.
    if (text && !/##\s+Tasks(?:\s*\/\s*Subtasks)?[\s\S]*?(?:\[ \]|\[x\])/i.test(text)) {
      issues.push(
        'Tasks (or Tasks/Subtasks) section with at least one `[ ]` or `[x]` checkbox missing',
      );
    }
  }
  return { ok: issues.length === 0, issues };
}

function verifyCheckReadiness(state, _out, ctx) {
  const issues = [];
  const text = state.story_file_path ? readFileSafe(ctx.fs, state.story_file_path) : null;
  const fm = frontMatter(text);
  if (!fm) {
    issues.push('story front-matter missing — cannot verify readiness verdict');
  } else if (!/readiness:\s*(true|false|ready|blocked)/i.test(fm)) {
    issues.push('readiness verdict not present in front-matter');
  }
  return { ok: issues.length === 0, issues };
}

function verifyDevRed(state, out, ctx) {
  const issues = [];
  // 1. Test files claimed in output exist.
  const testFiles = isNonEmptyArray(out.test_files) ? out.test_files : [];
  if (testFiles.length === 0) issues.push('no test_files reported');
  for (const f of testFiles) {
    if (!fileExists(ctx.fs, f)) issues.push(`test file missing: ${f}`);
  }
  // 2. Run the tests via the injected runner; expect non-zero exit (RED).
  if (ctx.runner) {
    const result = ctx.runner({ phase: 'red', files: testFiles });
    if (!result || typeof result.exit_code !== 'number') {
      issues.push('runner did not report exit_code');
    } else if (result.exit_code === 0) {
      issues.push('tests passed on RED phase — expected at least one failure');
    }
  }
  // 3. No source files mutated — LLM should have only added tests.
  if (isNonEmptyArray(out.source_files_changed)) {
    issues.push(
      `source files changed in RED phase: ${out.source_files_changed.join(',')} — expected tests only`,
    );
  }
  return { ok: issues.length === 0, issues };
}

function verifyDevGreen(state, out, ctx) {
  const issues = [];
  if (ctx.runner) {
    const result = ctx.runner({ phase: 'green', files: out.test_files || [] });
    if (!result || typeof result.exit_code !== 'number') {
      issues.push('runner did not report exit_code');
    } else if (result.exit_code !== 0) {
      issues.push(`tests still failing on GREEN: exit ${result.exit_code}`);
    } else if (typeof result.tests_run === 'number' && typeof out.tests_run === 'number') {
      if (result.tests_run !== out.tests_run) {
        issues.push(
          `LLM reported ${out.tests_run} tests run but runner reported ${result.tests_run}`,
        );
      }
    }
  }
  if (typeof out.tests_run !== 'number' || out.tests_run <= 0) {
    issues.push('tests_run must be a positive number (per AGENTS.md test-result format)');
  }
  return { ok: issues.length === 0, issues };
}

function verifyCodeReview(state, out, ctx) {
  const issues = [];
  const reviewPath = nodePath.join(
    ctx.projectRoot,
    '_bmad-output',
    'reviews',
    `${state.story_key || 'unknown'}.md`,
  );
  if (!fileExists(ctx.fs, reviewPath)) {
    issues.push(`review artifact missing: ${reviewPath}`);
  }
  const findings = Array.isArray(out.findings) ? out.findings : null;
  if (findings === null) {
    issues.push('findings[] missing from output — code-review must produce a triage payload');
  } else {
    for (let i = 0; i < findings.length; i += 1) {
      const f = findings[i];
      if (!f || typeof f !== 'object') {
        issues.push(`findings[${i}]: not an object`);
        continue;
      }
      if (!f.id) issues.push(`findings[${i}].id required`);
      if (!['block', 'patch', 'defer'].includes(f.action)) {
        issues.push(`findings[${i}].action must be block|patch|defer`);
      }
      if (!f.rationale) issues.push(`findings[${i}].rationale required`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function verifyPatchApply(state, out, _ctx) {
  const issues = [];
  const expected = Array.isArray(state.patch_findings) ? state.patch_findings.map((f) => f.id) : [];
  const applied = Array.isArray(out.applied_finding_ids) ? out.applied_finding_ids : [];
  for (const id of expected) {
    if (!applied.includes(id)) issues.push(`patch finding not applied: ${id}`);
  }
  if (out.commit_sha && typeof out.commit_sha !== 'string') {
    issues.push('commit_sha must be a string when present');
  }
  return { ok: issues.length === 0, issues };
}

function verifyPatchRetest(state, out, ctx) {
  const issues = [];
  if (ctx.runner) {
    const result = ctx.runner({
      phase: 'rereview',
      files: Array.isArray(state.tests_to_rerun) ? state.tests_to_rerun : out.test_files || [],
    });
    if (!result || typeof result.exit_code !== 'number') {
      issues.push('runner did not report exit_code');
    } else if (result.exit_code !== 0) {
      issues.push(`tests failed after patch: exit ${result.exit_code}`);
    }
  }
  if (typeof out.tests_run !== 'number' || out.tests_run <= 0) {
    issues.push('tests_run must be a positive number');
  }
  return { ok: issues.length === 0, issues };
}

function verifyStoryDone(state, out, ctx) {
  const issues = [];
  if (!out.commit_sha) issues.push('commit_sha required');
  if (!out.branch) issues.push('branch required');
  if (out.story_key && state.story_key && out.story_key !== state.story_key) {
    issues.push(`commit story_key mismatch: ${out.story_key} vs ${state.story_key}`);
  }
  // BMad bookkeeping: sprint-status.yaml MUST record this story as `done`.
  // Without this check, the LLM can claim STORY_DONE while sprint-status
  // still shows the story as `backlog`/`in-progress`, which means the next
  // story selection picks the wrong work item.
  if (state.story_key) {
    const sprintStatus = readSprintStatus(ctx.fs, ctx.projectRoot);
    if (!sprintStatus) {
      issues.push('sprint-status.yaml missing — required to mark story done');
    } else {
      const status = storyStatusFromSprintStatus(sprintStatus, state.story_key);
      if (status === null) {
        issues.push(
          `sprint-status.yaml has no entry for story ${state.story_key} — did create-story register it?`,
        );
      } else if (status !== 'done') {
        issues.push(
          `sprint-status.yaml shows story ${state.story_key} as '${status}', expected 'done'`,
        );
      }
    }
  }
  // BMad bookkeeping: story file's task checkboxes must all be checked.
  if (state.story_file_path) {
    const text = readFileSafe(ctx.fs, state.story_file_path);
    if (text) {
      const unchecked = (text.match(/\[ \]/g) || []).length;
      if (unchecked > 0) {
        issues.push(
          `story file has ${unchecked} unchecked task box(es) remaining — dev-story should flip all to [x]`,
        );
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

function verifyEpicBoundary(_state, _out, _ctx) {
  // Structural check only — no artifact expected.
  return { ok: true, issues: [] };
}

function verifyRetrospective(state, _out, ctx) {
  const issues = [];
  const epicKey = state.current_epic || 'unknown';
  const retroPath = nodePath.join(
    ctx.projectRoot,
    '_bmad-output',
    'retrospectives',
    `${epicKey}.md`,
  );
  if (!fileExists(ctx.fs, retroPath)) issues.push(`retro artifact missing: ${retroPath}`);
  return { ok: issues.length === 0, issues };
}

function verifyNanoQuickDev(state, out, ctx) {
  const issues = [];
  if (typeof out.tests_run !== 'number' || out.tests_run <= 0) {
    issues.push('tests_run must be a positive number');
  }
  if (typeof out.tests_failed !== 'number') {
    issues.push('tests_failed required (number; 0 for clean)');
  }
  if (!out.commit_sha) issues.push('commit_sha required');
  // BMad bookkeeping (nano edition): sprint-status.yaml MUST record the
  // story as `done` after a successful quick-dev cycle. Same enforcement
  // as the full-flow STORY_DONE phase.
  if (state.story_key) {
    const sprintStatus = readSprintStatus(ctx.fs, ctx.projectRoot);
    if (!sprintStatus) {
      issues.push('sprint-status.yaml missing — required to mark story done');
    } else {
      const status = storyStatusFromSprintStatus(sprintStatus, state.story_key);
      if (status === null) {
        issues.push(`sprint-status.yaml has no entry for story ${state.story_key}`);
      } else if (status !== 'done') {
        issues.push(
          `sprint-status.yaml shows story ${state.story_key} as '${status}', expected 'done'`,
        );
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

// verifyWithOverride — used when the LLM sends a verify_override signal.
// Re-runs verification with augmented expectations (from signal.evidence).
// Currently supports `expected_paths` — additional files the LLM claims
// satisfy the structural requirement that verify.js was looking for.
function verifyWithOverride(state, signalOutput, context, override) {
  const augmented = {
    ...context,
    augmented: override || null,
  };
  const base = verify(state, signalOutput, augmented);
  if (!override || !override.expected_paths) return base;
  // For now, the only augmentation is: if a test file the LLM renamed
  // exists in expected_paths, treat 'test file missing' issues as satisfied
  // when at least one of the expected_paths exists.
  const fs = (context && context.fs) || nodeFs;
  const someExists = override.expected_paths.some((p) => fileExists(fs, p));
  if (someExists) {
    const filtered = (base.issues || []).filter((i) => !/test file missing/.test(i));
    return { ok: filtered.length === 0, issues: filtered };
  }
  return base;
}

module.exports = {
  verify,
  verifyWithOverride,
  VERIFIERS,
};
