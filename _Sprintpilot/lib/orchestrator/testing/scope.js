// scope.js — resolve the effective test scope + command for a phase.
//
// resolveTestScope({ state, profile, projectRoot, baseBranch, phase })
//   → {
//       scope:    'affected' | 'full',
//       adapter:  'vitest' | 'jest' | 'pytest' | 'generic' | null,
//       command:  string | null,         // null = LLM decides
//       changed_files: string[] | null,
//       test_files:    string[],
//       reason:   string,                // one-line summary for the LLM + ledger
//       fallback: boolean,               // true when scope was downgraded
//     }
//
// Priority:
//   1. state.test_scope_hint === 'full'   → scope = 'full'
//   2. profile.testing_scope === 'full'   → scope = 'full'
//   3. otherwise                          → scope = 'affected'
//
// Within `affected`:
//   - pickAdapter() picks the best-fit adapter for the project layout.
//   - diff.changedFiles() gathers the modified-file set.
//   - state.test_files (story-authored tests) are always pinned.
//   - state.test_scope_hint may also carry include_dirs (string[]); those
//     are appended to changedFiles so the adapter sees them.
//   - If the adapter returns null (e.g. generic with no user command),
//     we fall back to full via profile.testing_fallback.
//
// `profile.testing_fallback` values:
//   - 'full'      (default) — silently downgrade to full
//   - 'directory' — try directory-mapped tests via inferTestDirs
//   - 'halt'      — return scope='affected' command=null with reason
//                   'fallback_halt'; caller (state-machine slot
//                   resolver) surfaces the issue to the LLM

'use strict';

const registry = require('./index');
const { changedFiles: diffChangedFiles } = require('./diff');

function resolveTestScope({
  state = {},
  profile = {},
  projectRoot,
  baseBranch,
  phase,
  // v2.4.0 — list of test IDs to exclude (quarantined flaky tests).
  // Passed through to adapter.buildCmd as `excludeTestIds`; also
  // mirrored into the result so the dev-story template can show the
  // LLM which tests are currently skipped.
  excludeTestIds = [],
  // v2.4.1 — when true, the recommended command appends adapter-specific
  // verbose / long-traceback flags. Drives diagnostic mode after two
  // consecutive failures so the third attempt has rich trace output to
  // feed the next fix attempt's prior_diagnosis.
  verbose = false,
}) {
  const hint = (state && state.test_scope_hint) || null;
  const wantFull =
    (hint && hint.scope === 'full') ||
    profile.testing_scope === 'full' ||
    profile.testing_scope === undefined; // safest default if knob missing
  if (wantFull) {
    const adapter = registry.pickAdapter(projectRoot);
    const command =
      adapter
        ? adapter.buildCmd({ scope: 'full', profile, projectRoot, excludeTestIds, verbose })
        : profile.testing_commands_full || null;
    return {
      scope: 'full',
      adapter: adapter ? adapter.NAME : null,
      command,
      changed_files: null,
      test_files: arrayOrEmpty(state.test_files),
      excluded_tests: arrayOrEmpty(excludeTestIds),
      reason: hint && hint.scope === 'full'
        ? 'story_hint_full'
        : 'profile_default_full',
      fallback: false,
    };
  }

  // Affected path.
  const adapter = registry.pickAdapter(projectRoot);
  const changed = projectRoot ? diffChangedFiles({ projectRoot, baseBranch }) : null;
  if (changed === null) {
    return downgrade({
      profile,
      projectRoot,
      reason: 'diff_unavailable',
      state,
      excludeTestIds,
    });
  }
  // Optional include_dirs widening from the story hint.
  const includeDirs =
    hint && Array.isArray(hint.include_dirs)
      ? hint.include_dirs.filter((d) => typeof d === 'string' && d.length > 0)
      : [];
  const widened = includeDirs.length > 0 ? [...changed, ...includeDirs] : changed;
  const testFiles = arrayOrEmpty(state.test_files);
  const command = adapter
    ? adapter.buildCmd({
        scope: 'affected',
        changedFiles: widened,
        testFiles,
        profile,
        projectRoot,
        baseRef: baseBranch || profile.base_branch || 'main',
        excludeTestIds,
        verbose,
      })
    : null;
  if (!command) {
    return downgrade({
      profile,
      projectRoot,
      reason: adapter ? 'adapter_no_affected_command' : 'no_adapter_match',
      state,
      changed_files: widened,
      excludeTestIds,
    });
  }
  return {
    scope: 'affected',
    adapter: adapter ? adapter.NAME : null,
    command,
    changed_files: widened,
    test_files: testFiles,
    excluded_tests: arrayOrEmpty(excludeTestIds),
    reason: includeDirs.length > 0
      ? `affected_with_hint_dirs:${includeDirs.length}`
      : 'affected_from_diff',
    fallback: false,
  };
}

function downgrade({ profile, projectRoot, reason, state, changed_files = null, excludeTestIds = [] }) {
  const policy = (profile && profile.testing_fallback) || 'full';
  if (policy === 'halt') {
    return {
      scope: 'affected',
      adapter: null,
      command: null,
      changed_files,
      test_files: arrayOrEmpty(state.test_files),
      excluded_tests: arrayOrEmpty(excludeTestIds),
      reason: `fallback_halt:${reason}`,
      fallback: true,
    };
  }
  // 'directory' policy currently degrades to full — the pytest adapter's
  // inferTestDirs already covers the python case, and Node-stack runners
  // don't have a clean dir convention. Treat it as full for now.
  const adapter = registry.pickAdapter(projectRoot);
  const command = adapter
    ? adapter.buildCmd({ scope: 'full', profile, projectRoot, excludeTestIds })
    : (profile && profile.testing_commands_full) || null;
  return {
    scope: 'full',
    adapter: adapter ? adapter.NAME : null,
    command,
    changed_files,
    test_files: arrayOrEmpty(state.test_files),
    excluded_tests: arrayOrEmpty(excludeTestIds),
    reason: `fallback:${reason}`,
    fallback: true,
  };
}

function arrayOrEmpty(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : [];
}

module.exports = { resolveTestScope };
