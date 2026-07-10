import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import sm from '../../../_Sprintpilot/lib/orchestrator/state-machine.js';
// @ts-expect-error — CommonJS module
import verifyMod from '../../../_Sprintpilot/lib/orchestrator/verify.js';

const { verify, verifyWithOverride } = verifyMod as {
  verify: (
    state: Record<string, unknown>,
    out: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => { ok: boolean; issues: string[] };
  verifyWithOverride: (
    state: Record<string, unknown>,
    out: Record<string, unknown>,
    ctx: Record<string, unknown>,
    override: Record<string, unknown>,
  ) => { ok: boolean; issues: string[] };
};

const { STATES } = sm as { STATES: Record<string, string> };

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sp-verify-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function makeStoryFile(text: string): string {
  const dir = join(projectRoot, '_bmad-output', 'stories');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'S1.md');
  writeFileSync(p, text, 'utf8');
  return p;
}

function makeReviewFile(): string {
  const dir = join(projectRoot, '_bmad-output', 'reviews');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'S1.md');
  writeFileSync(p, '# review\n', 'utf8');
  return p;
}

describe('verify CREATE_STORY', () => {
  it('ok when story file has front-matter, AC, and Tasks/Subtasks checkboxes', () => {
    const path = makeStoryFile(
      `---\nstory_key: S1\n---\n\n## Acceptance Criteria\n- AC1\n- AC2\n\n## Tasks\n- [ ] write tests\n- [ ] implement\n`,
    );
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: path },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('accepts "Tasks/Subtasks" heading variant', () => {
    const path = makeStoryFile(
      `---\nstory_key: S1\n---\n\n## Acceptance Criteria\n- AC1\n\n## Tasks/Subtasks\n- [ ] do thing\n`,
    );
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: path },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('fails when story file missing', () => {
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: join(projectRoot, 'no.md') },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(false);
  });

  it('fails when AC section is missing', () => {
    const path = makeStoryFile(`---\nstory_key: S1\n---\n\nsome body\n\n## Tasks\n- [ ] x\n`);
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: path },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('Acceptance Criteria');
  });

  it('fails when Tasks/Subtasks section is missing', () => {
    const path = makeStoryFile(`---\nstory_key: S1\n---\n\n## Acceptance Criteria\n- AC1\n`);
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: path },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('Tasks');
  });

  it('fails when Tasks section has no checkboxes', () => {
    const path = makeStoryFile(
      `---\nstory_key: S1\n---\n\n## Acceptance Criteria\n- AC1\n\n## Tasks\n- write tests\n- implement\n`,
    );
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: path },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('checkbox');
  });

  it('falls back to signal.output.story_file_path when state.story_file_path is null (first-success regression)', () => {
    // Real-world bug from a v2.2.0 session ledger:
    //   {"kind":"verify_result","phase":"create_story","ok":false,
    //    "issues":["story_file_path not set"]}
    // Cause: adapt.advanceState propagates story_file_path AFTER verify
    // runs, so the first successful create_story signal fails verify
    // even though the LLM correctly reported the path in signal.output.
    // Fix: verify() merges signal.output's identity fields onto an
    // effective state when state's values are null.
    const path = makeStoryFile(
      `---\nstory_key: 4-8-realm\n---\n\n## Acceptance Criteria\n- AC1\n\n## Tasks\n- [ ] x\n`,
    );
    const r = verify(
      // state has no story_file_path (first emission after composeRuntimeState
      // resolved only story_key from sprint-status)
      { phase: STATES.CREATE_STORY, story_key: '4-8-realm', story_file_path: null },
      // signal.output reports the path the LLM just wrote
      { story_file_path: path },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('auto-detects the story file by convention when state AND signal both omit the path', () => {
    // Recurring failure mode: the LLM ran bmad-create-story (file is on disk
    // at _bmad-output/implementation-artifacts/<key>.md) but signaled success
    // WITHOUT echoing story_file_path. Both state and signal.output are null,
    // so the older code rejected with "story_file_path not set" — which then
    // cascaded into a phase_timeout halt. verify() now resolves the
    // conventional path when it exists on disk.
    const dir = join(projectRoot, '_bmad-output', 'implementation-artifacts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '16-9-telegram-voice-notes.md'),
      `---\nstory_key: 16-9-telegram-voice-notes\n---\n\n## Acceptance Criteria\n- AC1\n\n## Tasks\n- [ ] x\n`,
      'utf8',
    );
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: '16-9-telegram-voice-notes', story_file_path: null },
      {}, // signal omitted story_file_path
      { projectRoot },
    );
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('still rejects when neither the signal nor a conventional file provides the path', () => {
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'nonexistent-story', story_file_path: null },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('story_file_path not set');
  });

  it('verify_override evidence.acknowledge_missing_front_matter skips ONLY the front-matter check', () => {
    // Escape hatch for legacy stories where bmad-create-story can't or
    // won't regenerate front-matter. AC + Tasks still enforced — the
    // override is narrow.
    const path = makeStoryFile(
      `# Story 4.9: Legacy WS Handshake\n\n` +
        `Status: backlog\n\n` +
        `## Acceptance Criteria\n- AC1\n\n` +
        `## Tasks\n- [ ] design\n`,
    );
    // Without override: rejects (no front-matter).
    const baseR = verify(
      { phase: STATES.CREATE_STORY, story_key: '4-9-foo', story_file_path: path },
      {},
      { projectRoot },
    );
    expect(baseR.ok).toBe(false);
    expect(baseR.issues.join(' ')).toContain('missing YAML front-matter');
    // With override: passes. AC + Tasks still verified.
    const okR = verifyMod.verifyWithOverride(
      { phase: STATES.CREATE_STORY, story_key: '4-9-foo', story_file_path: path },
      {},
      { projectRoot },
      { acknowledge_missing_front_matter: true, decision_log_ref: 'DEC-LEGACY-FRONT-MATTER' },
    );
    expect(okR.ok).toBe(true);
    expect(okR.issues).toEqual([]);
  });

  it('verify_override acknowledge_missing_front_matter does NOT skip AC or Tasks checks', () => {
    // Override is narrow — missing AC or Tasks still fail.
    const path = makeStoryFile(`# Story\n\nNo AC, no Tasks.\n`);
    const r = verifyMod.verifyWithOverride(
      { phase: STATES.CREATE_STORY, story_key: 'X', story_file_path: path },
      {},
      { projectRoot },
      { acknowledge_missing_front_matter: true },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('Acceptance Criteria');
    expect(r.issues.join(' ')).toContain('Tasks');
  });

  it('state.story_file_path still wins when both state and signal.output are set', () => {
    // Precedence guard: an in-flight retry with stale signal.output
    // must not clobber the authoritative state path. Verify uses
    // state's value, not signal's.
    const stateFile = makeStoryFile(
      `---\nstory_key: S1\n---\n\n## Acceptance Criteria\n- AC1\n\n## Tasks\n- [ ] x\n`,
    );
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: stateFile },
      { story_file_path: '/nope/wrong.md' },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('accepts ### Acceptance Criteria (heading level 3, nested under Dev Notes)', () => {
    // BMad templates sometimes nest AC inside another section using ###.
    // Pre-2.2.25 the regex required exactly ##, rejecting valid stories.
    const path = makeStoryFile(
      '---\nstory_key: S1\n---\n\n## Dev Notes\n\n### Acceptance Criteria\n- AC1\n\n## Tasks\n- [ ] do it\n',
    );
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: path },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('accepts numbered AC list (1. / 1)) instead of bullet -', () => {
    const path = makeStoryFile(
      '---\nstory_key: S1\n---\n\n## Acceptance Criteria\n1. AC one\n2. AC two\n\n## Tasks\n- [ ] do it\n',
    );
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: path },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('accepts `* AC` markers (asterisk bullets) instead of dash', () => {
    const path = makeStoryFile(
      '---\nstory_key: S1\n---\n\n## Acceptance Criteria\n* AC one\n\n## Tasks\n- [ ] do it\n',
    );
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: path },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('accepts the AC abbreviation as heading', () => {
    const path = makeStoryFile('---\nstory_key: S1\n---\n\n## AC\n- a\n\n## Tasks\n- [ ] do it\n');
    const r = verify(
      { phase: STATES.CREATE_STORY, story_key: 'S1', story_file_path: path },
      {},
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });
});

describe('verify CHECK_READINESS', () => {
  it('ok when verdict present in front-matter', () => {
    const path = makeStoryFile(`---\nreadiness: ready\n---\n\nbody`);
    const r = verify({ phase: STATES.CHECK_READINESS, story_file_path: path }, {}, { projectRoot });
    expect(r.ok).toBe(true);
  });

  it('fails when verdict missing', () => {
    const path = makeStoryFile(`---\nstory_key: S1\n---\nbody`);
    const r = verify({ phase: STATES.CHECK_READINESS, story_file_path: path }, {}, { projectRoot });
    expect(r.ok).toBe(false);
  });
});

describe('verify DEV_RED', () => {
  it('ok when test_files exist + runner exits non-zero + no source mutated', () => {
    const tf = join(projectRoot, 't.test.ts');
    writeFileSync(tf, 'test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_RED },
      { test_files: [tf] },
      { projectRoot, runner: () => ({ exit_code: 1 }) },
    );
    expect(r.ok).toBe(true);
  });

  it('fails when runner exits zero (no failing tests on RED)', () => {
    const tf = join(projectRoot, 't.test.ts');
    writeFileSync(tf, 'test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_RED },
      { test_files: [tf] },
      { projectRoot, runner: () => ({ exit_code: 0 }) },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('expected at least one failure');
  });

  it('fails when source files mutated in RED phase', () => {
    const tf = join(projectRoot, 't.test.ts');
    writeFileSync(tf, 'test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_RED },
      { test_files: [tf], source_files_changed: ['src/x.ts'] },
      { projectRoot, runner: () => ({ exit_code: 1 }) },
    );
    expect(r.ok).toBe(false);
  });

  it('fails when test_files missing', () => {
    const r = verify(
      { phase: STATES.DEV_RED },
      {},
      { projectRoot, runner: () => ({ exit_code: 1 }) },
    );
    expect(r.ok).toBe(false);
  });

  it('auto-detects test_files from untracked files when LLM omits the array', () => {
    // Real user pain point: LLM does the work, writes the test, but signals
    // `success` with empty output. Verifier should recover from this by
    // scanning the working tree for newly added test-shaped files.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: projectRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: projectRoot });
    // LLM wrote this but didn't echo it back. It's untracked.
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'feature.test.ts'), 'test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_RED },
      {}, // no test_files array — the bug we're fixing
      { projectRoot, runner: () => ({ exit_code: 1 }) },
    ) as { ok: boolean; issues: string[]; autodetected_test_files?: string[] };
    expect(r.ok).toBe(true);
    expect(r.autodetected_test_files).toBeDefined();
    expect(r.autodetected_test_files?.[0]).toContain('feature.test.ts');
  });

  it('does not autodetect when test_files IS provided (LLM-supplied takes precedence)', () => {
    const tf = join(projectRoot, 't.test.ts');
    writeFileSync(tf, 'test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_RED },
      { test_files: [tf] },
      { projectRoot, runner: () => ({ exit_code: 1 }) },
    ) as { ok: boolean; autodetected_test_files?: string[] };
    expect(r.ok).toBe(true);
    expect(r.autodetected_test_files).toBeUndefined();
  });

  it('resolves relative test_files paths against projectRoot (not process.cwd())', () => {
    // Real user pain: LLM reports test_files as repo-relative paths like
    // "apps/gateway/tests/auth/x.test.ts" but fileExists checked them
    // against process.cwd() — the file was there but the verifier said
    // "test file missing".
    mkdirSync(join(projectRoot, 'apps', 'gateway', 'tests'), { recursive: true });
    writeFileSync(join(projectRoot, 'apps', 'gateway', 'tests', 'a.test.ts'), 't', 'utf8');
    const r = verify(
      { phase: STATES.DEV_RED },
      { test_files: ['apps/gateway/tests/a.test.ts'] },
      { projectRoot, runner: () => ({ exit_code: 1 }) },
    );
    expect(r.ok).toBe(true);
  });

  it('falls through to strict rejection when working tree has no test-shaped files', () => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: projectRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: projectRoot });
    writeFileSync(join(projectRoot, 'README.md'), 'not a test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_RED },
      {},
      { projectRoot, runner: () => ({ exit_code: 1 }) },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('no test_files reported');
  });
});

describe('verify DEV_GREEN', () => {
  it('ok when runner exits 0 and tests_run matches', () => {
    const r = verify(
      { phase: STATES.DEV_GREEN },
      { tests_run: 5, test_files: [] },
      { projectRoot, runner: () => ({ exit_code: 0, tests_run: 5 }) },
    );
    expect(r.ok).toBe(true);
  });

  it('fails when runner exits non-zero', () => {
    const r = verify(
      { phase: STATES.DEV_GREEN },
      { tests_run: 5 },
      { projectRoot, runner: () => ({ exit_code: 1, tests_run: 5 }) },
    );
    expect(r.ok).toBe(false);
  });

  it('flags LLM under-reporting test count', () => {
    const r = verify(
      { phase: STATES.DEV_GREEN },
      { tests_run: 3 },
      { projectRoot, runner: () => ({ exit_code: 0, tests_run: 7 }) },
    );
    expect(r.ok).toBe(false);
  });

  it('fails when tests_run is missing AND runner does not report it', () => {
    const r1 = verify(
      { phase: STATES.DEV_GREEN },
      {},
      { projectRoot, runner: () => ({ exit_code: 0 }) }, // no tests_run from runner
    );
    expect(r1.ok).toBe(false);
    const r2 = verify(
      { phase: STATES.DEV_GREEN },
      { tests_run: 0 },
      { projectRoot, runner: () => ({ exit_code: 0 }) },
    );
    expect(r2.ok).toBe(false);
  });

  it('accepts when runner reports tests_run > 0 even if LLM omits it', () => {
    // Recurring pain: LLM signals success with tests passing but forgets
    // to echo tests_run. Verifier should accept when the runner provides
    // a positive count.
    const r = verify(
      { phase: STATES.DEV_GREEN },
      {}, // LLM forgot tests_run
      { projectRoot, runner: () => ({ exit_code: 0, tests_run: 9 }) },
    );
    expect(r.ok).toBe(true);
  });

  it('skips post-green-gates when lint_enabled is false (default)', () => {
    // No lint config → no post-green-gates spawn → no impact on pass/fail.
    const tf = join(projectRoot, 't.test.ts');
    writeFileSync(tf, 'test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_GREEN },
      { tests_run: 5, test_files: [tf] },
      { projectRoot, runner: () => ({ exit_code: 0, tests_run: 5 }) },
    );
    expect(r.ok).toBe(true);
  });

  it('lint_enabled=true + post-green-gates.js missing → does not halt (graceful degrade)', () => {
    // Partial install / older version. Lint runs but the script isn't
    // there. Should pass through, not block the autopilot.
    const tf = join(projectRoot, 't.test.ts');
    writeFileSync(tf, 'test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_GREEN },
      { tests_run: 5, test_files: [tf] },
      {
        projectRoot,
        runner: () => ({ exit_code: 0, tests_run: 5 }),
        profile: { lint_enabled: true, lint_blocking: true },
      },
    );
    expect(r.ok).toBe(true);
  });

  it('lint_enabled=true + post-green-gates fails + lint_blocking=true → verify rejects', () => {
    // Stage a fake post-green-gates.js that always exits 1.
    const scriptDir = join(projectRoot, '_Sprintpilot', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(scriptDir, 'post-green-gates.js'),
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({failed_gate:"lint-changed",first_issue:"missing semicolon"}));\nprocess.exit(1);\n',
      'utf8',
    );
    const tf = join(projectRoot, 't.test.ts');
    writeFileSync(tf, 'test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_GREEN },
      { tests_run: 5, test_files: [tf] },
      {
        projectRoot,
        runner: () => ({ exit_code: 0, tests_run: 5 }),
        profile: { lint_enabled: true, lint_blocking: true },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('post-green-gates failed');
  });

  it('lint_enabled=true forwards lint_output_limit + lint_linters to post-green-gates (v2.2.28)', () => {
    // Stage a fake post-green-gates that echoes argv to a sentinel file
    // so we can assert the orchestrator forwarded the knobs.
    const scriptDir = join(projectRoot, '_Sprintpilot', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    const sentinel = join(projectRoot, 'pgg-argv.json');
    writeFileSync(
      join(scriptDir, 'post-green-gates.js'),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(
        sentinel,
      )}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(0);\n`,
      'utf8',
    );
    const tf = join(projectRoot, 't.test.ts');
    writeFileSync(tf, 'test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_GREEN },
      { tests_run: 5, test_files: [tf] },
      {
        projectRoot,
        runner: () => ({ exit_code: 0, tests_run: 5 }),
        profile: {
          lint_enabled: true,
          lint_blocking: true,
          lint_output_limit: 42,
          lint_linters: { python: ['pylint'], javascript: ['biome'] },
        },
      },
    );
    expect(r.ok).toBe(true);
    // Re-import after the verify call wrote it.
    const argv = JSON.parse(readFileSync(sentinel, 'utf8')) as string[];
    expect(argv).toContain('--output-limit');
    expect(argv[argv.indexOf('--output-limit') + 1]).toBe('42');
    expect(argv).toContain('--linters-json');
    const linters = JSON.parse(argv[argv.indexOf('--linters-json') + 1]);
    expect(linters.python).toEqual(['pylint']);
    expect(linters.javascript).toEqual(['biome']);
  });

  it('lint_enabled=true + post-green-gates fails + lint_blocking=false → verify still accepts', () => {
    // Non-blocking lint failure: log it but don't halt.
    const scriptDir = join(projectRoot, '_Sprintpilot', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(scriptDir, 'post-green-gates.js'),
      '#!/usr/bin/env node\nprocess.exit(1);\n',
      'utf8',
    );
    const tf = join(projectRoot, 't.test.ts');
    writeFileSync(tf, 'test', 'utf8');
    const r = verify(
      { phase: STATES.DEV_GREEN },
      { tests_run: 5, test_files: [tf] },
      {
        projectRoot,
        runner: () => ({ exit_code: 0, tests_run: 5 }),
        profile: { lint_enabled: true, lint_blocking: false },
      },
    );
    expect(r.ok).toBe(true);
  });
});

describe('verify CODE_REVIEW', () => {
  it('ok with valid findings[]', () => {
    makeReviewFile();
    const r = verify(
      { phase: STATES.CODE_REVIEW, story_key: 'S1' },
      {
        findings: [
          { id: 'F1', action: 'patch', rationale: 'fix' },
          { id: 'F2', action: 'defer', rationale: 'minor' },
        ],
      },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('fails when review artifact missing', () => {
    const r = verify(
      { phase: STATES.CODE_REVIEW, story_key: 'S1' },
      { findings: [] },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
  });

  it('fails when findings[] missing (no triage)', () => {
    makeReviewFile();
    const r = verify({ phase: STATES.CODE_REVIEW, story_key: 'S1' }, {}, { projectRoot });
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('triage');
  });

  it('fails when finding.action is invalid', () => {
    makeReviewFile();
    const r = verify(
      { phase: STATES.CODE_REVIEW, story_key: 'S1' },
      { findings: [{ id: 'F1', action: 'maybe', rationale: 'x' }] },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
  });

  it('accepts a story file with "### Review Findings" section (what bmad-code-review actually writes)', () => {
    // Real-world: bmad-code-review's step-04-present.md writes findings INTO
    // the story file's Tasks/Subtasks block, NOT to _bmad-output/reviews/<k>.md.
    // The pre-2.2.17 verifier rejected every real run because it checked for
    // a file the skill never creates.
    const storyDir = join(projectRoot, '_bmad-output', 'stories');
    mkdirSync(storyDir, { recursive: true });
    const storyPath = join(storyDir, 'S1.md');
    writeFileSync(
      storyPath,
      '## Tasks\n\n- [x] implement\n\n### Review Findings\n- F1: defer (minor)\n',
      'utf8',
    );
    const r = verify(
      { phase: STATES.CODE_REVIEW, story_key: 'S1', story_file_path: storyPath },
      { findings: [{ id: 'F1', action: 'defer', rationale: 'minor' }] },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('accepts the legacy implementation-artifacts/code-review-<key>.md location', () => {
    // Some repos in the wild have this older layout. Don't break them.
    const artDir = join(projectRoot, '_bmad-output', 'implementation-artifacts');
    mkdirSync(artDir, { recursive: true });
    writeFileSync(join(artDir, 'code-review-S1.md'), '# review\n', 'utf8');
    const r = verify(
      { phase: STATES.CODE_REVIEW, story_key: 'S1' },
      { findings: [{ id: 'F1', action: 'defer', rationale: 'minor' }] },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  // A3 — tolerate BMad v6.10's reworked review/edge-case-hunter heading wording.
  for (const heading of [
    '### Review Findings',
    '## Code Review Findings',
    '#### Findings',
    '### Triage',
  ]) {
    it(`accepts review-findings heading variant "${heading}"`, () => {
      const storyDir = join(projectRoot, '_bmad-output', 'stories');
      mkdirSync(storyDir, { recursive: true });
      const storyPath = join(storyDir, 'S1.md');
      writeFileSync(storyPath, `## Tasks\n\n- [x] implement\n\n${heading}\n- F1: defer\n`, 'utf8');
      const r = verify(
        { phase: STATES.CODE_REVIEW, story_key: 'S1', story_file_path: storyPath },
        { findings: [{ id: 'F1', action: 'defer', rationale: 'minor' }] },
        { projectRoot },
      );
      expect(r.ok).toBe(true);
    });
  }

  it('still rejects when no review artifact and no findings heading exist', () => {
    const storyDir = join(projectRoot, '_bmad-output', 'stories');
    mkdirSync(storyDir, { recursive: true });
    const storyPath = join(storyDir, 'S1.md');
    writeFileSync(storyPath, '## Tasks\n\n- [x] implement\n', 'utf8');
    const r = verify(
      { phase: STATES.CODE_REVIEW, story_key: 'S1', story_file_path: storyPath },
      { findings: [{ id: 'F1', action: 'defer', rationale: 'minor' }] },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/review artifact missing/);
  });
});

describe('verify PATCH_APPLY', () => {
  it('ok when all expected findings applied', () => {
    const r = verify(
      {
        phase: STATES.PATCH_APPLY,
        patch_findings: [{ id: 'F1' }, { id: 'F2' }],
      },
      { applied_finding_ids: ['F1', 'F2'], commit_sha: 'abc' },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('fails when a finding is missed', () => {
    const r = verify(
      { phase: STATES.PATCH_APPLY, patch_findings: [{ id: 'F1' }, { id: 'F2' }] },
      { applied_finding_ids: ['F1'] },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
  });
});

function seedSprintStatus(content: string) {
  const dir = join(projectRoot, '_bmad-output', 'implementation-artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sprint-status.yaml'), content, 'utf8');
}

function seedStoryFileWithTasks(unchecked: number, checked: number): string {
  const dir = join(projectRoot, '_bmad-output', 'stories');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'S1.md');
  const tasks = [
    ...Array.from({ length: unchecked }, (_, i) => `- [ ] task ${i + 1}`),
    ...Array.from({ length: checked }, (_, i) => `- [x] done ${i + 1}`),
  ].join('\n');
  writeFileSync(
    p,
    `---\nstory_key: S1\nreadiness: ready\n---\n\n## Acceptance Criteria\n- AC1\n\n## Tasks\n${tasks}\n`,
    'utf8',
  );
  return p;
}

describe('verify STORY_DONE', () => {
  it('ok with sprint-status done + no unchecked tasks + branch + commit_sha + git_steps_completed', () => {
    seedSprintStatus('development_status:\n  S1:\n    status: done\n    title: x\n');
    const storyPath = seedStoryFileWithTasks(0, 2);
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1', story_file_path: storyPath },
      {
        commit_sha: 'abc',
        branch: 'story/S1',
        story_key: 'S1',
        git_steps_completed: true,
      },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it("fails when git_steps_completed is missing — LLM ran 'git commit' but not 'git push'", () => {
    seedSprintStatus('development_status:\n  S1: done\n');
    const storyPath = seedStoryFileWithTasks(0, 1);
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1', story_file_path: storyPath },
      { commit_sha: 'abc', branch: 'story/S1', story_key: 'S1' },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('git_steps_completed must be true');
  });

  it('fails when git_steps_completed is false', () => {
    seedSprintStatus('development_status:\n  S1: done\n');
    const storyPath = seedStoryFileWithTasks(0, 1);
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1', story_file_path: storyPath },
      {
        commit_sha: 'abc',
        branch: 'story/S1',
        story_key: 'S1',
        git_steps_completed: false,
      },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('git_steps_completed must be true');
  });

  it('auto-confirms git_steps_completed when commit exists locally + origin/<branch> matches', () => {
    // Real user pain point: the LLM did the commit AND the push, but
    // forgot to echo `git_steps_completed: true` in signal.output.
    // Without this fix the verifier rejects, retry budget burns, halt.
    //
    // Probe path: cat-file -e <sha> + ls-remote --heads origin <branch>.
    // Set up a local repo with a bare "origin" sibling so the push step
    // can actually run and ls-remote can resolve the sha.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
    const originRoot = mkdtempSync(join(tmpdir(), 'sp-verify-origin-'));
    try {
      execFileSync('git', ['init', '--bare', '-q', '-b', 'main', originRoot]);
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot });
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: projectRoot });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: projectRoot });
      execFileSync('git', ['remote', 'add', 'origin', originRoot], { cwd: projectRoot });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: projectRoot });
      execFileSync('git', ['checkout', '-qb', 'story/S1'], { cwd: projectRoot });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: S1', '-q'], {
        cwd: projectRoot,
      });
      execFileSync('git', ['push', '-q', 'origin', 'story/S1'], { cwd: projectRoot });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        cwd: projectRoot,
      }).trim();
      seedSprintStatus('development_status:\n  S1: done\n');
      const storyPath = seedStoryFileWithTasks(0, 1);
      const r = verify(
        { phase: STATES.STORY_DONE, story_key: 'S1', story_file_path: storyPath },
        {
          commit_sha: sha,
          branch: 'story/S1',
          story_key: 'S1',
          // git_steps_completed deliberately omitted — the recovery path
        },
        { projectRoot },
      );
      expect(r.ok).toBe(true);
    } finally {
      rmSync(originRoot, { recursive: true, force: true });
    }
  });

  it('fails when sprint-status.yaml is missing', () => {
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1' },
      { commit_sha: 'abc', branch: 'story/S1' },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('sprint-status.yaml missing');
  });

  it("fails when sprint-status shows story as 'backlog' / 'in-progress'", () => {
    seedSprintStatus('development_status:\n  S1:\n    status: backlog\n    title: x\n');
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1' },
      { commit_sha: 'abc', branch: 'story/S1' },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain("expected 'done'");
  });

  it('fails when story has no entry in sprint-status', () => {
    seedSprintStatus('development_status:\n  OTHER:\n    status: done\n');
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1' },
      { commit_sha: 'abc', branch: 'story/S1' },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('no entry for story S1');
  });

  it('passes when inline status has a trailing `# comment` (BMad PR-merge convention)', () => {
    // Regression: pre-v2.2.3 storyStatusFromSprintStatus required `\s*$`
    // immediately after the status token, so `  S1: done  # PR #123 merged`
    // failed to match and verifyStoryDone rejected the story as
    // "shows S1 as 'null', expected 'done'". The repo's convention is
    // `<key>: done  # PR #N merged ...` for every merged story.
    seedSprintStatus('development_status:\n  S1: done  # PR #123 merged 2026-05-15\n');
    const storyPath = seedStoryFileWithTasks(0, 1);
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1', story_file_path: storyPath },
      {
        commit_sha: 'abc',
        branch: 'story/S1',
        story_key: 'S1',
        git_steps_completed: true,
      },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('passes when inline status uses quoted value + trailing comment', () => {
    seedSprintStatus('development_status:\n  S1: "done"  # PR #99 merged\n');
    const storyPath = seedStoryFileWithTasks(0, 1);
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1', story_file_path: storyPath },
      {
        commit_sha: 'abc',
        branch: 'story/S1',
        story_key: 'S1',
        git_steps_completed: true,
      },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('fails when unchecked task boxes remain', () => {
    seedSprintStatus('development_status:\n  S1:\n    status: done\n');
    const storyPath = seedStoryFileWithTasks(2, 1);
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1', story_file_path: storyPath },
      { commit_sha: 'abc', branch: 'story/S1' },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('unchecked task box');
  });

  it('accepts inline-form sprint-status (key: done)', () => {
    seedSprintStatus('development_status:\n  S1: done\n');
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1' },
      { commit_sha: 'abc', branch: 'story/S1', git_steps_completed: true },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('fails on story_key mismatch', () => {
    seedSprintStatus('development_status:\n  S1:\n    status: done\n');
    const r = verify(
      { phase: STATES.STORY_DONE, story_key: 'S1' },
      { commit_sha: 'abc', branch: 'story/S2', story_key: 'S2' },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
  });
});

describe('verify STORY_LAND', () => {
  it('ok when git_steps_completed is true', () => {
    const r = verify(
      { phase: STATES.STORY_LAND, story_key: 'S1' },
      { git_steps_completed: true },
      { projectRoot, profile: { base_branch: 'main' } },
    );
    expect(r.ok).toBe(true);
  });

  it('fails when git_steps_completed is omitted and git cannot confirm the merge', () => {
    // projectRoot is a fresh temp dir (not a git repo) so the ancestry probe
    // returns false; with no explicit flag the land is unconfirmed.
    const r = verify(
      { phase: STATES.STORY_LAND, story_key: 'S1' },
      { commit_sha: 'abc', branch: 'story/S1' },
      { projectRoot, profile: { base_branch: 'main' } },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('git_steps_completed must be true');
  });

  it('names the base branch from the profile in the issue', () => {
    const r = verify(
      { phase: STATES.STORY_LAND, story_key: 'S1' },
      {},
      { projectRoot, profile: { base_branch: 'develop' } },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('into develop');
  });
});

describe('verify NANO_QUICK_DEV', () => {
  it('ok with tests_run, tests_failed=0, commit_sha + sprint-status=done', () => {
    seedSprintStatus('development_status:\n  S1: done\n');
    const r = verify(
      { phase: STATES.NANO_QUICK_DEV, story_key: 'S1' },
      { tests_run: 5, tests_failed: 0, commit_sha: 'abc' },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('ok with tests_failed > 0 — orchestrator escalates separately; verify only structural', () => {
    seedSprintStatus('development_status:\n  S1: done\n');
    const r = verify(
      { phase: STATES.NANO_QUICK_DEV, story_key: 'S1' },
      { tests_run: 5, tests_failed: 2, commit_sha: 'abc' },
      { projectRoot },
    );
    expect(r.ok).toBe(true);
  });

  it('fails when commit_sha missing', () => {
    seedSprintStatus('development_status:\n  S1: done\n');
    const r = verify(
      { phase: STATES.NANO_QUICK_DEV, story_key: 'S1' },
      { tests_run: 5, tests_failed: 0 },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
  });

  it("fails when sprint-status still shows 'in-progress'", () => {
    seedSprintStatus('development_status:\n  S1: in-progress\n');
    const r = verify(
      { phase: STATES.NANO_QUICK_DEV, story_key: 'S1' },
      { tests_run: 5, tests_failed: 0, commit_sha: 'abc' },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain("expected 'done'");
  });

  // BMad v6.10 quick-dev self-syncs sprint-status through `in-progress` →
  // `review` → `done` (sync-sprint-status.md). The nano verifier must require
  // the terminal `done`: a run that stalled at the new intermediate `review`
  // state is NOT a completed story.
  it("fails when 6.10 quick-dev left the story at the intermediate 'review' state", () => {
    seedSprintStatus('development_status:\n  S1: review\n');
    const r = verify(
      { phase: STATES.NANO_QUICK_DEV, story_key: 'S1' },
      { tests_run: 5, tests_failed: 0, commit_sha: 'abc' },
      { projectRoot },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain("expected 'done'");
  });

  it('accepts when runner reports tests_run > 0 even if LLM omits it', () => {
    seedSprintStatus('development_status:\n  S1: done\n');
    const r = verify(
      { phase: STATES.NANO_QUICK_DEV, story_key: 'S1' },
      { tests_failed: 0, commit_sha: 'abc' }, // no tests_run
      { projectRoot, runner: () => ({ exit_code: 0, tests_run: 7 }) },
    );
    expect(r.ok).toBe(true);
  });
});

describe('verify RETROSPECTIVE', () => {
  it('ok when retro file exists for epic', () => {
    const dir = join(projectRoot, '_bmad-output', 'retrospectives');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'E1.md'), 'retro', 'utf8');
    const r = verify({ phase: STATES.RETROSPECTIVE, current_epic: 'E1' }, {}, { projectRoot });
    expect(r.ok).toBe(true);
  });

  it('fails when retro artifact missing', () => {
    const r = verify({ phase: STATES.RETROSPECTIVE, current_epic: 'E1' }, {}, { projectRoot });
    expect(r.ok).toBe(false);
  });
});

describe('verifyWithOverride', () => {
  it('accepts when expected_paths exist (test file renamed scenario)', () => {
    // Original verification expects a specific test file — but the LLM
    // renamed it and supplies the new path as evidence.
    const newPath = join(projectRoot, 'renamed.test.ts');
    writeFileSync(newPath, 'test', 'utf8');
    const result = verifyWithOverride(
      { phase: STATES.DEV_RED },
      { test_files: [join(projectRoot, 'old.test.ts')], source_files_changed: [] },
      { projectRoot, runner: () => ({ exit_code: 1 }) },
      { expected_paths: [newPath] },
    );
    // 'test file missing' issues are filtered; remaining issues should be none.
    expect(result.ok).toBe(true);
  });

  it('rejects when expected_paths do not exist', () => {
    const result = verifyWithOverride(
      { phase: STATES.DEV_RED },
      { test_files: [join(projectRoot, 'old.test.ts')] },
      { projectRoot, runner: () => ({ exit_code: 1 }) },
      { expected_paths: [join(projectRoot, 'still-missing.ts')] },
    );
    expect(result.ok).toBe(false);
  });
});

describe('verify error handling', () => {
  it('returns ok=false when state.phase missing', () => {
    const r = verify({} as Record<string, unknown>, {}, {});
    expect(r.ok).toBe(false);
  });

  it('returns ok=true for unknown phase (defers to state machine)', () => {
    const r = verify({ phase: 'mystery' }, {}, {});
    expect(r.ok).toBe(true);
  });
});
