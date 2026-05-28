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
//
// Tolerates trailing `# comment` on inline status lines — the BMad
// convention is `<key>: done  # PR #N merged ...` and the previous
// regex required `\s*$` immediately after the status token, rejecting
// every commented entry. The block-form inner status regex never
// anchored to end-of-line, so it always tolerated comments.
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
  // Optional trailing `# comment` is allowed so `done  # PR #N merged`
  // matches `done` instead of failing the whole line.
  const inlineRe = new RegExp(
    `^\\s+${k}:\\s*["']?([\\w-]+)["']?\\s*(?:#.*)?$`,
    'm',
  );
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

// Auto-detect test files added/modified since the story branch started.
// Used by verifyDevRed when the LLM forgets to echo `test_files` in
// signal.output — a recurring user pain point: the LLM did the work but
// signaled `success` with empty output, causing the verifier to halt with
// "no test_files reported", retry budget exhausted, session dies.
//
// Lists git diff vs base-branch + untracked files, filters to test-shaped
// paths via TEST_FILE_PATTERNS. Returns [] on any error so the caller
// falls through to the strict rejection rather than silently accepting.
const TEST_FILE_PATTERNS = [
  /(^|\/)[^/]+\.test\.(?:[mc]?jsx?|[mc]?tsx?)$/i,
  /(^|\/)[^/]+\.spec\.(?:[mc]?jsx?|[mc]?tsx?)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /(^|\/)[^/]+_test\.py$/i,
  /(^|\/)[^/]+_test\.go$/i,
  /(^|\/)tests?\/[^/]+\.rs$/i,
  /(^|\/)[^/]+Tests?\.swift$/i,
  /(^|\/)[^/]+Test\.(?:kt|java)$/i,
  /(^|\/)[^/]+_test\.rb$/i,
  /(^|\/)[^/]+_spec\.rb$/i,
];

function looksLikeTestFile(p) {
  return TEST_FILE_PATTERNS.some((re) => re.test(p));
}

function autoDetectTestFiles(ctx, baseBranch) {
  if (!ctx || !ctx.projectRoot) return [];
  const projectRoot = ctx.projectRoot;
  const NUL = String.fromCharCode(0);
  const base = baseBranch || 'main';
  const cp = require('node:child_process');
  function runGit(extra) {
    try {
      return cp.execFileSync(
        'git',
        ['-C', projectRoot, ...extra],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
      );
    } catch {
      return null;
    }
  }
  // Prefer base...HEAD; fall back to a 5-commit window if origin/<base>
  // isn't fetched. -z separates entries with NUL so filenames with spaces
  // survive intact.
  let raw = runGit(['diff', '--name-only', '--no-renames', '-z', base + '...HEAD']);
  if (raw === null) raw = runGit(['diff', '--name-only', '--no-renames', '-z', 'HEAD~5..HEAD']);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z']);
  const parts = [];
  for (const buf of [raw, untracked]) {
    if (!buf) continue;
    for (const p of buf.split(NUL)) {
      const t = p.trim();
      if (t) parts.push(t);
    }
  }
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (!looksLikeTestFile(p)) continue;
    const abs = nodePath.isAbsolute(p) ? p : nodePath.join(projectRoot, p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

// Invoke scripts/post-green-gates.js when profile.lint_enabled is true.
// Returns null when:
//   - profile.lint_enabled is false / absent (feature opt-out)
//   - the script is missing (partial install)
//   - projectRoot is unset
// Returns { failed: bool, summary?: string } on a real run.
//
// The script's contract: exit 0 = all gates pass, exit !=0 = at least
// one gate failed. JSON report on stdout when invoked with --json (we
// pass that flag). Failure summary captured for the issue message.
function runPostGreenGates(ctx) {
  if (!ctx || !ctx.profile || !ctx.profile.lint_enabled) return null;
  if (!ctx.projectRoot) return null;
  const scriptRel = nodePath.join('_Sprintpilot', 'scripts', 'post-green-gates.js');
  const scriptAbs = nodePath.join(ctx.projectRoot, scriptRel);
  let fs;
  try {
    fs = ctx.fs || nodeFs;
    if (!fs.existsSync(scriptAbs)) return null;
  } catch {
    return null;
  }
  const cp = require('node:child_process');
  const args = [scriptAbs, '--json', '--project-root', ctx.projectRoot];
  // Forward output_limit so lint-changed.js honors git.lint.output_limit.
  if (typeof ctx.profile.lint_output_limit === 'number' && ctx.profile.lint_output_limit > 0) {
    args.push('--output-limit', String(ctx.profile.lint_output_limit));
  }
  // Forward the per-language linter map. Users reorder priorities or
  // disable linters via git.lint.linters.{language}: [list].
  if (ctx.profile.lint_linters && typeof ctx.profile.lint_linters === 'object') {
    try {
      args.push('--linters-json', JSON.stringify(ctx.profile.lint_linters));
    } catch {
      /* malformed user config — ignore, fall back to defaults */
    }
  }
  try {
    const r = cp.spawnSync(
      'node',
      args,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    );
    if (r.status === 0) return { failed: false };
    // Try to extract a brief summary from the JSON output. Fall back
    // to the exit code if parsing fails.
    let summary = `exit ${r.status}`;
    try {
      const parsed = JSON.parse(r.stdout || '{}');
      if (parsed && parsed.failed_gate) summary = `failed_gate=${parsed.failed_gate}`;
      if (parsed && parsed.first_issue) summary += `: ${parsed.first_issue}`;
    } catch {
      /* keep exit-code summary */
    }
    return { failed: true, summary };
  } catch (_e) {
    // Script crashed (e.g. ENOENT for node). Treat as non-failing —
    // the lint phase should not gate the autopilot on its own bugs.
    return null;
  }
}

// Probe the underlying git state to confirm a STORY_DONE signal whose
// `git_steps_completed` flag was omitted. Returns true iff:
//   - commit_sha resolves locally (git cat-file -e <sha>)
//   - origin/<branch> resolves to the same sha (git ls-remote)
//
// Both checks must pass; either alone is insufficient (local commit
// without push, or remote pointing at a different commit, means the
// story isn't really done).
//
// Returns false on any error / missing tooling so the caller falls
// through to the strict rejection.
function verifyGitStepsViaProbe(out, ctx) {
  if (!ctx || !ctx.projectRoot) return false;
  if (!out || !out.commit_sha || !out.branch) return false;
  const projectRoot = ctx.projectRoot;
  const cp = require('node:child_process');
  function runGit(args) {
    try {
      return cp.execFileSync(
        'git',
        ['-C', projectRoot, ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
      );
    } catch {
      return null;
    }
  }
  // Local commit exists?
  const local = runGit(['cat-file', '-e', out.commit_sha]);
  if (local === null) return false;
  // Remote tracks the same sha? -h restricts to refs/heads/<branch>.
  const remote = runGit(['ls-remote', '--heads', 'origin', out.branch]);
  if (!remote) return false;
  // ls-remote output is "<sha>\trefs/heads/<branch>\n"
  const remoteSha = remote.split(/\s+/)[0];
  return typeof remoteSha === 'string' && remoteSha === out.commit_sha;
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
  [STATES.STORY_LAND]: verifyStoryLand,
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
    profile: (context && context.profile) || null,
  };
  const out = signalOutput || {};
  // Effective state: fall forward to signal.output for identity fields
  // that composeRuntimeState couldn't pre-populate (only story_file_path
  // and ac_summary — story_key + current_epic are already resolved from
  // sprint-status before verify runs). Without this, the FIRST successful
  // CREATE_STORY signal always fails verify with "story_file_path not
  // set" because adapt.advanceState propagates the path AFTER verify, not
  // before.
  //
  // Precedence: state wins when set; signal.output is fallback. This
  // preserves verifyStoryDone's explicit out.story_key !== state.story_key
  // mismatch check at line 273 — that comparison still sees the
  // original state value (which is non-null by STORY_DONE).
  const effectiveState =
    state.story_file_path && state.ac_summary
      ? state
      : {
          ...state,
          story_file_path: state.story_file_path || out.story_file_path || null,
          ac_summary: state.ac_summary || out.ac_summary || null,
        };
  try {
    return fn(effectiveState, out, ctx);
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
    // Escape hatch: when the LLM sends verify_override with evidence
    // {acknowledge_missing_front_matter: true, decision_log_ref: '...'},
    // skip the front-matter check ONLY for this verification call. AC +
    // Tasks checks still run. Auditable via the verify_override ledger
    // entry which captures evidence verbatim. Used when bmad-create-story
    // can't or won't regenerate front-matter (e.g., legacy story files
    // in repos that pre-date the front-matter convention and have a
    // body the skill wants to preserve).
    const override = ctx.augmented || {};
    const ackMissingFm = override && override.acknowledge_missing_front_matter === true;
    if (!fm && !ackMissingFm) issues.push('story file missing YAML front-matter');
    // AC presence — look for an Acceptance Criteria section with at
    // least one list entry. Accepts:
    //   - heading levels ##, ###, #### (BMad standard is ##; some templates
    //     nest AC under Dev Notes which would use ###)
    //   - "Acceptance Criteria" / "Acceptance criteria" / "AC" (the abbr
    //     appears in some templates)
    //   - bullet markers `-` or `*` or numbered `1.` / `1)` lists
    if (
      text &&
      !/#{2,4}\s+(?:Acceptance Criteria|Acceptance criteria|AC)\b[\s\S]*?\n[ \t]*(?:[-*]|\d+[.)])\s+\S/i.test(
        text,
      )
    ) {
      issues.push('Acceptance Criteria section missing or empty');
    }
    // Tasks/Subtasks section with at least one task checkbox — required by
    // BMad bookkeeping. `bmad-create-story` produces unchecked `[ ]`
    // entries; `bmad-dev-story` flips them to `[x]`. If neither is present,
    // dev-story will have nothing to check off. Accept heading levels
    // ## / ### / #### (templates sometimes nest Tasks under Dev Notes).
    if (text && !/#{2,4}\s+Tasks(?:\s*\/\s*Subtasks)?[\s\S]*?(?:\[ \]|\[x\])/i.test(text)) {
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
  // 1. Test files claimed in output exist. If the LLM omitted test_files
  //    (a recurring failure mode), auto-detect from git diff / untracked
  //    files in the project tree so the verifier doesn't halt on a
  //    cosmetic signaling gap. Detected paths flow through the same
  //    fileExists check as LLM-supplied paths.
  let testFiles = isNonEmptyArray(out.test_files) ? out.test_files : [];
  let autodetected = false;
  if (testFiles.length === 0 && ctx && ctx.projectRoot) {
    const detected = autoDetectTestFiles(ctx, state && state.base_branch);
    if (detected.length > 0) {
      testFiles = detected;
      autodetected = true;
    }
  }
  if (testFiles.length === 0) issues.push('no test_files reported');
  // Resolve relative paths against projectRoot. LLM-supplied test_files
  // are often relative like "apps/gateway/tests/x.test.ts" but the
  // verifier runs from wherever cmdRecord was invoked. Without the
  // resolve, fileExists checks against process.cwd() and reports
  // "test file missing" for paths that actually exist.
  for (const f of testFiles) {
    const resolved =
      nodePath.isAbsolute(f) || !ctx.projectRoot ? f : nodePath.join(ctx.projectRoot, f);
    if (!fileExists(ctx.fs, resolved)) issues.push(`test file missing: ${f}`);
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
  const result = { ok: issues.length === 0, issues };
  if (autodetected) result.autodetected_test_files = testFiles;
  return result;
}

function verifyDevGreen(state, out, ctx) {
  const issues = [];
  let runnerTestsRun = null;
  if (ctx.runner) {
    const result = ctx.runner({ phase: 'green', files: out.test_files || [] });
    if (!result || typeof result.exit_code !== 'number') {
      issues.push('runner did not report exit_code');
    } else if (result.exit_code !== 0) {
      issues.push(`tests still failing on GREEN: exit ${result.exit_code}`);
    } else {
      if (typeof result.tests_run === 'number') runnerTestsRun = result.tests_run;
      if (typeof result.tests_run === 'number' && typeof out.tests_run === 'number') {
        if (result.tests_run !== out.tests_run) {
          issues.push(
            `LLM reported ${out.tests_run} tests run but runner reported ${result.tests_run}`,
          );
        }
      }
    }
  }
  // If the LLM omitted tests_run but the runner reported a positive
  // count, accept the runner's number (same pattern as test_files
  // auto-detect). A non-runner setup still requires the LLM to report.
  if (typeof out.tests_run !== 'number' || out.tests_run <= 0) {
    if (typeof runnerTestsRun === 'number' && runnerTestsRun > 0) {
      // Recovered — don't push the "must be a positive number" issue.
    } else {
      issues.push('tests_run must be a positive number (per AGENTS.md test-result format)');
    }
  }
  // Post-GREEN gates: lint-changed + lint-test-pitfalls + ci-parity scan.
  // Composed pipeline lives in scripts/post-green-gates.js. Only fires
  // when profile.lint_enabled === true. Blocking vs non-blocking is
  // governed by profile.lint_blocking.
  const lintResult = runPostGreenGates(ctx);
  if (lintResult) {
    if (lintResult.failed && (ctx.profile && ctx.profile.lint_blocking)) {
      issues.push(
        `post-green-gates failed (lint_blocking=true): ${lintResult.summary || 'see ledger detail'}`,
      );
    }
  }
  return { ok: issues.length === 0, issues };
}

function verifyCodeReview(state, out, ctx) {
  const issues = [];
  // bmad-code-review writes findings as a "### Review Findings"
  // subsection inside the story file's Tasks/Subtasks block (see
  // .claude/skills/bmad-code-review/steps/step-04-present.md). Older
  // repo layouts also use a separate review file. Accept any of:
  //   - story file contains a `### Review Findings` section
  //   - `_bmad-output/reviews/<key>.md` exists
  //   - `_bmad-output/implementation-artifacts/code-review-<key>.md` exists
  // Reject only when NONE of the above exist AND the LLM didn't supply
  // findings[] inline.
  const storyKey = state.story_key || 'unknown';
  const reviewLegacy = nodePath.join(
    ctx.projectRoot,
    '_bmad-output',
    'reviews',
    `${storyKey}.md`,
  );
  const reviewArtifact = nodePath.join(
    ctx.projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    `code-review-${storyKey}.md`,
  );
  const storyFile = state.story_file_path;
  let foundReview = false;
  if (fileExists(ctx.fs, reviewLegacy) || fileExists(ctx.fs, reviewArtifact)) {
    foundReview = true;
  } else if (storyFile) {
    const text = readFileSafe(ctx.fs, storyFile);
    if (text && /^#{2,4}\s+Review Findings\b/m.test(text)) foundReview = true;
  }
  if (!foundReview) {
    issues.push(
      `review artifact missing: expected one of (a) "### Review Findings" section in ${storyFile || '<story file>'}, (b) ${reviewLegacy}, or (c) ${reviewArtifact}`,
    );
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
  let runnerTestsRun = null;
  if (ctx.runner) {
    const result = ctx.runner({
      phase: 'rereview',
      files: Array.isArray(state.tests_to_rerun) ? state.tests_to_rerun : out.test_files || [],
    });
    if (!result || typeof result.exit_code !== 'number') {
      issues.push('runner did not report exit_code');
    } else if (result.exit_code !== 0) {
      issues.push(`tests failed after patch: exit ${result.exit_code}`);
    } else if (typeof result.tests_run === 'number') {
      runnerTestsRun = result.tests_run;
    }
  }
  // Same auto-recovery as verifyDevGreen: accept the runner's count when
  // the LLM omits tests_run.
  if (typeof out.tests_run !== 'number' || out.tests_run <= 0) {
    if (!(typeof runnerTestsRun === 'number' && runnerTestsRun > 0)) {
      issues.push('tests_run must be a positive number');
    }
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
  // The orchestrator decorated this phase's git_op action with the planned
  // argv steps (commit + push). Without this check, the LLM can run only
  // `git commit` and report success — leaving the story branch unpushed.
  // Confirmed live in greenfield e2e: signal had commit_sha+branch but
  // origin/<branch> never appeared on remote.
  //
  // Recovery path (recurring user pain): the LLM did the work but forgot
  // to echo `git_steps_completed: true`. Probe the underlying git state —
  // if the commit_sha exists locally AND origin/<branch> resolves to it,
  // accept the signal. The full audit trail is in the ledger via the
  // verify_result entry, so a false-positive auto-accept stays observable.
  if (out.git_steps_completed !== true) {
    const autoConfirmed = verifyGitStepsViaProbe(out, ctx);
    if (!autoConfirmed) {
      issues.push(
        'git_steps_completed must be true — set to true ONLY after every step in action.steps (git add, commit, push) exited 0. Skipping git push is the most common cause.',
      );
    }
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

// Probe git to confirm a STORY_LAND signal whose `git_steps_completed`
// flag was omitted: the story's commit must be reachable from origin/<base>
// (it was merged into base AND base was pushed). Returns false on any error,
// missing tooling, missing commit_sha, or a squash-merge (where the original
// sha isn't an ancestor of the squashed commit) — the caller then falls
// through to requiring the explicit flag.
function verifyLandViaProbe(out, base, ctx) {
  if (!ctx || !ctx.projectRoot) return false;
  const sha = out && out.commit_sha;
  if (!sha) return false;
  const cp = require('node:child_process');
  try {
    cp.execFileSync(
      'git',
      ['-C', ctx.projectRoot, 'merge-base', '--is-ancestor', sha, `origin/${base}`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
    );
    return true; // exit 0 → sha is an ancestor of origin/<base> → merged + pushed
  } catch {
    return false;
  }
}

function verifyStoryLand(state, out, ctx) {
  const issues = [];
  const base = (ctx.profile && ctx.profile.base_branch) || 'main';
  // The land step merges the story branch into <base>, pushes <base>, and
  // deletes the local branch (see scripts/land-this-pr.js). Confirm the
  // merge+push actually happened before advancing — otherwise the next
  // story branches from a <base> that doesn't contain this one, which is
  // exactly the land_as_you_go invariant this state exists to uphold.
  //
  // Mirrors verifyStoryDone: the canonical signal is
  // `git_steps_completed: true`; when omitted, probe git (sha ∈ origin/<base>)
  // and accept the signal when the probe confirms. Squash merges can't be
  // confirmed by sha, so under squash the explicit flag is required.
  if (out.git_steps_completed !== true) {
    const landed = verifyLandViaProbe(out, base, ctx);
    if (!landed) {
      issues.push(
        `git_steps_completed must be true — set it ONLY after every land step ` +
          `(merge the story branch into ${base} + \`git push origin ${base}\`) ` +
          `exited 0. Skipping the merge/push leaves the story unlanded; the next ` +
          `story would branch from a ${base} that doesn't contain it.`,
      );
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
  // tests_run: accept the runner's count if the LLM omitted it (same
  // pattern as verifyDevGreen). Nano flow can also have ctx.runner.
  let runnerTestsRun = null;
  if (ctx.runner) {
    const result = ctx.runner({ phase: 'quick', files: out.test_files || [] });
    if (result && typeof result.tests_run === 'number') runnerTestsRun = result.tests_run;
  }
  if (typeof out.tests_run !== 'number' || out.tests_run <= 0) {
    if (!(typeof runnerTestsRun === 'number' && runnerTestsRun > 0)) {
      issues.push('tests_run must be a positive number');
    }
  }
  if (typeof out.tests_failed !== 'number') {
    // tests_failed missing: if LLM signaled success AND runner exit_code
    // was 0 OR all tests passed (out.tests_run > 0 with no failure
    // indicator), default to 0. Otherwise reject.
    // Conservative: only auto-fill 0 when we have positive evidence of
    // no failures (LLM count present and matches success status).
    // Keeping the strict check by default — tests_failed is a key
    // signal the verifier uses for nano escalation.
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
  const root = context && context.projectRoot;
  const someExists = override.expected_paths.some((p) => {
    const resolved = nodePath.isAbsolute(p) || !root ? p : nodePath.join(root, p);
    return fileExists(fs, resolved);
  });
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
