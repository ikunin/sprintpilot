import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('fails when tests_run is missing or zero', () => {
    const r1 = verify(
      { phase: STATES.DEV_GREEN },
      {},
      { projectRoot, runner: () => ({ exit_code: 0 }) },
    );
    expect(r1.ok).toBe(false);
    const r2 = verify(
      { phase: STATES.DEV_GREEN },
      { tests_run: 0 },
      { projectRoot, runner: () => ({ exit_code: 0 }) },
    );
    expect(r2.ok).toBe(false);
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
