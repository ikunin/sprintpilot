/**
 * Orchestrator end-to-end smoke test.
 *
 * Drives the autopilot.js CLI through a complete story cycle from a fresh
 * project root via real `node bin/autopilot.js` subprocess calls. The LLM
 * is replaced by scripted signals to keep the test offline and deterministic.
 *
 * This is the reliability proof for the full plan — every Phase 1..7
 * module integrated, every BMad invariant exercised through the actual
 * CLI surface (not just the pure-module unit tests).
 *
 * Path: CREATE_STORY → CHECK_READINESS → DEV_RED → DEV_GREEN →
 *       CODE_REVIEW(patch) → PATCH_APPLY → PATCH_RETEST → STORY_DONE
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = join(__dirname, '..', '..', '_Sprintpilot', 'bin', 'autopilot.js');
const REPO_PROFILES = join(
  __dirname,
  '..',
  '..',
  '_Sprintpilot',
  'modules',
  'autopilot',
  'profiles',
);

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sp-e2e-smoke-'));
  // Seed a complete autopilot config.
  const cfgDir = join(projectRoot, '_Sprintpilot', 'modules', 'autopilot');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.yaml'),
    'complexity_profile: medium\nautopilot:\n  execution_mode: orchestrator\n',
    'utf8',
  );
  const profilesDir = join(cfgDir, 'profiles');
  mkdirSync(profilesDir, { recursive: true });
  for (const f of [
    '_base.yaml',
    'nano.yaml',
    'small.yaml',
    'medium.yaml',
    'large.yaml',
    'legacy.yaml',
  ]) {
    writeFileSync(join(profilesDir, f), readFileSync(join(REPO_PROFILES, f), 'utf8'), 'utf8');
  }
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function cli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args, '--project-root', projectRoot], {
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout || '', status: err.status ?? 1 };
  }
}

function record(signal: object): { stdout: string; status: number } {
  return cli(['record', '--signal', JSON.stringify(signal)]);
}

function patchState(updates: Record<string, string>) {
  const statePath = join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'autopilot-state.yaml',
  );
  let existing = '';
  try {
    existing = readFileSync(statePath, 'utf8');
  } catch (_e) {
    /* fresh */
  }
  const extra = Object.entries(updates)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(statePath, `${existing}${extra}\n`, 'utf8');
}

function seedStoryFile() {
  const dir = join(projectRoot, '_bmad-output', 'stories');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'S1.md');
  writeFileSync(
    p,
    [
      '---',
      'story_key: S1',
      'readiness: ready',
      '---',
      '',
      '## Acceptance Criteria',
      '- AC1',
      '- AC2',
      '',
      '## Tasks',
      '- [ ] write failing tests',
      '- [ ] implement feature',
      '',
    ].join('\n'),
    'utf8',
  );
  patchState({ current_story: 'S1', story_file_path: p });
  return p;
}

function markStoryTasksDone(p: string) {
  const text = readFileSync(p, 'utf8');
  writeFileSync(p, text.replace(/- \[ \]/g, '- [x]'), 'utf8');
}

function seedSprintStatusDone() {
  const dir = join(projectRoot, '_bmad-output', 'implementation-artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sprint-status.yaml'), 'development_status:\n  S1: done\n', 'utf8');
}

function seedTestFiles(): string[] {
  const tf = join(projectRoot, 'src', 'feature.test.ts');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(tf, 'test placeholder', 'utf8');
  return [tf];
}

function seedReviewFile() {
  const dir = join(projectRoot, '_bmad-output', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'S1.md'), '# review\n', 'utf8');
}

describe('Orchestrator end-to-end smoke (full story cycle)', () => {
  it('drives CREATE_STORY → STORY_DONE via the CLI with verify on every step', () => {
    // 1. boot
    const start = cli(['start']);
    expect(start.status).toBe(0);
    const startPayload = JSON.parse(start.stdout);
    expect(startPayload.phase).toBe('create_story');
    expect(startPayload.action.skill).toBe('bmad-create-story');

    // 2. CREATE_STORY succeeds — set up the artifact verify expects
    const storyPath = seedStoryFile();
    const r1 = record({ status: 'success' });
    expect(r1.status).toBe(0);
    expect(JSON.parse(r1.stdout).phase).toBe('check_readiness');

    // 3. CHECK_READINESS — file already has `readiness: ready` in front-matter
    const r2 = record({ status: 'success' });
    expect(JSON.parse(r2.stdout).phase).toBe('dev_red');

    // 4. DEV_RED — write tests, runner reports non-zero (RED confirmed)
    // We can't actually run a child process from within the orchestrator
    // verify, so we craft a signal whose claim verify can validate from
    // the filesystem alone. The verifier accepts when ctx.runner is absent.
    const testFiles = seedTestFiles();
    const r3 = record({ status: 'success', output: { test_files: testFiles } });
    expect(JSON.parse(r3.stdout).phase).toBe('dev_green');

    // 5. DEV_GREEN — runner not invoked from inside verify (no runner injected),
    // but tests_run is required to be positive.
    const r4 = record({ status: 'success', output: { tests_run: 3 } });
    expect(JSON.parse(r4.stdout).phase).toBe('code_review');

    // 6. CODE_REVIEW — emit findings with one patch finding
    seedReviewFile();
    const r5 = record({
      status: 'success',
      output: {
        findings: [
          { id: 'F1', action: 'patch', rationale: 'fix lint' },
          { id: 'F2', action: 'defer', rationale: 'minor' },
        ],
      },
    });
    expect(JSON.parse(r5.stdout).phase).toBe('patch_apply');

    // 7. PATCH_APPLY — claim the patch finding is applied
    const r6 = record({
      status: 'success',
      output: { applied_finding_ids: ['F1'], commit_sha: 'abc123' },
    });
    expect(JSON.parse(r6.stdout).phase).toBe('patch_retest');

    // 8. PATCH_RETEST — clean
    const r7 = record({
      status: 'success',
      output: { tests_run: 3, remaining_findings: [] },
    });
    expect(JSON.parse(r7.stdout).phase).toBe('story_done');

    // 9. STORY_DONE — BMad bookkeeping: tasks all checked, sprint-status
    // shows the story as done. Without these, verify.js rejects.
    markStoryTasksDone(storyPath);
    seedSprintStatusDone();
    const r8 = record({
      status: 'success',
      output: {
        commit_sha: 'def456',
        branch: 'story/s1',
        story_key: 'S1',
        git_steps_completed: true,
      },
    });
    expect(JSON.parse(r8.stdout).phase).toBe('epic_boundary_check');

    // Validate the ledger captured the full sequence.
    const ledgerPath = join(
      projectRoot,
      '_bmad-output',
      'implementation-artifacts',
      'ledger.jsonl',
    );
    const ledger = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const phases = ledger
      .filter((e: { kind: string }) => e.kind === 'state_transition')
      .map((e: { to: string }) => e.to);
    // Expected forward progression through the BMad cycle.
    expect(phases).toEqual([
      'check_readiness',
      'dev_red',
      'dev_green',
      'code_review',
      'patch_apply',
      'patch_retest',
      'story_done',
      'epic_boundary_check',
    ]);
    // Verify-result entries exist for every phase that had a verifier.
    const verifyResults = ledger.filter((e: { kind: string }) => e.kind === 'verify_result');
    expect(verifyResults.length).toBeGreaterThanOrEqual(7);
    for (const v of verifyResults) {
      expect(v.ok).toBe(true);
    }
  });

  it('routes a blocking finding to user_prompt — step-6 block path', () => {
    cli(['start']);
    const storyPath = seedStoryFile();
    record({ status: 'success' }); // CREATE_STORY
    record({ status: 'success' }); // CHECK_READINESS
    record({ status: 'success', output: { test_files: seedTestFiles() } }); // DEV_RED
    record({ status: 'success', output: { tests_run: 3 } }); // DEV_GREEN
    seedReviewFile();
    const r = record({
      status: 'success',
      output: {
        findings: [{ id: 'B1', action: 'block', rationale: 'arch decision' }],
      },
    });
    const payload = JSON.parse(r.stdout);
    expect(payload.verdict).toBe('prompted');
    expect(payload.action.type).toBe('user_prompt');
    expect(payload.action.reason).toBe('code_review_blocking_findings');
    // The phase stays at code_review — orchestrator does not auto-skip a block.
    expect(payload.phase).toBe('code_review');
    expect(storyPath).toBeDefined(); // keep ts happy
  });

  it('decisions[] gets appended through the CLI', () => {
    cli(['start']);
    seedStoryFile();
    record({
      status: 'success',
      decisions: [
        {
          category: 'test-strategy',
          impact: 'low',
          phase: 'dev-story:RED',
          decision: 'use vitest',
          rationale: 'matches repo',
        },
      ],
    });
    const logPath = join(
      projectRoot,
      '_bmad-output',
      'implementation-artifacts',
      'decision-log.yaml',
    );
    const text = readFileSync(logPath, 'utf8');
    expect(text).toContain('id: DEC-001');
    expect(text).toContain('decision: use vitest');
    expect(text).toContain('category: test-strategy');
  });

  it('honors `execution_mode: orchestrator` as the new default', () => {
    // Validate-config exposes the orchestrator-driven typed Profile.
    const r = cli(['validate-config']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.profile.name).toBe('medium');
    expect(parsed.profile.implementation_flow).toBe('full');
  });

  it('emits a session report covering the cycle', () => {
    cli(['start']);
    seedStoryFile();
    record({ status: 'success' }); // → check_readiness
    record({ status: 'success' }); // → dev_red
    const r = cli(['report']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# Autopilot Session Report');
    expect(r.stdout).toContain('Current phase');
    expect(r.stdout).toContain('Ledger summary');
    expect(r.stdout).toContain('autopilot next');
  });
});
