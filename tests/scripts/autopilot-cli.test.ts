import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = join(__dirname, '..', '..', '_Sprintpilot', 'bin', 'autopilot.js');

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sp-autopilot-cli-'));
  // Seed a minimal autopilot/config.yaml so resolve-profile.js doesn't warn.
  const cfgDir = join(projectRoot, '_Sprintpilot', 'modules', 'autopilot');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.yaml'), 'complexity_profile: medium\n', 'utf8');
  // git.enabled: false skips the PREPARE_STORY_BRANCH precursor so these
  // CLI tests can keep asserting on the legacy CREATE_STORY/NANO_QUICK_DEV
  // first-action contract. Branch-creation correctness is covered by the
  // dedicated unit tests (state-machine, git-plan, decorateGitOp).
  // resolve-profile.js reads modules/git/config.yaml separately from
  // modules/autopilot/config.yaml, so this knob has to live in its own
  // file.
  const gitCfgDir = join(projectRoot, '_Sprintpilot', 'modules', 'git');
  mkdirSync(gitCfgDir, { recursive: true });
  writeFileSync(join(gitCfgDir, 'config.yaml'), 'enabled: false\n', 'utf8');
  // Profile YAMLs the resolver expects to read.
  const profilesDir = join(cfgDir, 'profiles');
  mkdirSync(profilesDir, { recursive: true });
  // Copy real profiles from this repo.
  const repoProfiles = join(
    __dirname,
    '..',
    '..',
    '_Sprintpilot',
    'modules',
    'autopilot',
    'profiles',
  );
  for (const f of [
    '_base.yaml',
    'nano.yaml',
    'small.yaml',
    'medium.yaml',
    'large.yaml',
    'legacy.yaml',
  ]) {
    writeFileSync(join(profilesDir, f), readFileSync(join(repoProfiles, f), 'utf8'), 'utf8');
  }
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function runCli(args: string[], opts: { input?: string } = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args, '--project-root', projectRoot], {
      encoding: 'utf8',
      input: opts.input,
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout || '', status: err.status ?? 1 };
  }
}

describe('autopilot validate-config', () => {
  it('resolves a typed Profile for the medium default', () => {
    const r = runCli(['validate-config']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.profile.name).toBe('medium');
    expect(parsed.profile.implementation_flow).toBe('full');
  });

  it('respects --profile override', () => {
    const r = runCli(['validate-config', '--profile', 'nano']);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.profile.name).toBe('nano');
    expect(parsed.profile.implementation_flow).toBe('quick');
  });
});

describe('autopilot start', () => {
  it('nano profile boots at NANO_QUICK_DEV (not CREATE_STORY)', () => {
    // Fresh session under complexity_profile=nano must emit
    // invoke_skill: bmad-quick-dev as its first action. Pre-fix this
    // hardcoded current_bmad_step=create_story and forced the LLM down
    // the full 7-step flow even under nano.
    writeFileSync(
      join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml'),
      'complexity_profile: nano\n',
      'utf8',
    );
    const r = runCli(['start']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.phase).toBe('nano_quick_dev');
    expect(parsed.action.type).toBe('invoke_skill');
    expect(parsed.action.skill).toBe('bmad-quick-dev');
  });

  it('boots a fresh session and emits the create_story action', () => {
    const r = runCli(['start']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.phase).toBe('create_story');
    expect(parsed.action.skill).toBe('bmad-create-story');
  });

  it('record at an epic boundary emits a RESOLVED next-story action (no re-fetch needed)', () => {
    // Reproduces the "transient resolver hiccup": adapt clears story_key at
    // the boundary and relies on composeRuntimeState to re-resolve the queue
    // head. cmdRecord must run that resolver itself so its emitted action
    // already names the next story — eliminating the mandatory `next`
    // re-fetch. (git.enabled:false → boundary lands on CREATE_STORY.)
    mkdirSync(join(projectRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(
      join(projectRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
      'development_status:\n  1-1-a: done\n  1-2-b: ready-for-dev\n',
    );
    writeFileSync(
      join(projectRoot, '_bmad-output', 'implementation-artifacts', 'autopilot-state.yaml'),
      [
        'current_bmad_step: epic_boundary_check',
        'current_epic: "1"',
        'story_queue: ["1-2-b"]',
        '',
      ].join('\n'),
    );
    const r = runCli(['record', '--signal', JSON.stringify({ status: 'success' })]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    // The emitted action must already target 1-2-b, and the next_summary
    // must name it — not the under-resolved operation fallback.
    expect(parsed.next_summary).toContain('1-2-b');
    expect(JSON.stringify(parsed.action)).toContain('1-2-b');
  });

  it('emits a human-readable next_summary alongside the action', () => {
    const r = runCli(['start']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    // The authoritative "what runs next" line — surfaced to the user so they
    // never have to cross-reference autopilot-state / sprint-plan / ledger.
    expect(typeof parsed.next_summary).toBe('string');
    expect(parsed.next_summary).toMatch(/^NEXT: /);
    expect(parsed.next_summary).toContain('step create_story');
  });

  it('logs that lint_enabled is active (v2.2.24+: post-green-gates.js wired into verifyDevGreen)', () => {
    // v2.2.24: lint_enabled now actually runs scripts/post-green-gates.js
    // during DEV_GREEN verify. The v2.2.23 "experimental warning" ledger
    // entry was replaced with a positive `lint_enabled: true` confirmation.
    const gitCfgDir = join(projectRoot, '_Sprintpilot', 'modules', 'git');
    mkdirSync(gitCfgDir, { recursive: true });
    writeFileSync(
      join(gitCfgDir, 'config.yaml'),
      'enabled: false\nlint:\n  enabled: true\n  blocking: true\n',
      'utf8',
    );
    runCli(['start']);
    const ledgerPath = join(
      projectRoot,
      '_bmad-output',
      'implementation-artifacts',
      'ledger.jsonl',
    );
    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
    const entries = lines.map((l) => JSON.parse(l));
    const lintEntry = entries.find(
      (e) => e.detail && e.detail.lint_enabled === true,
    );
    expect(lintEntry).toBeDefined();
    expect(lintEntry.detail.lint_blocking).toBe(true);
  });

  it('logs a parallel_stories_notice when ma.parallel_stories=true', () => {
    // planBatch / dispatch-layer.js are wired as building blocks but
    // nextAction emits stories sequentially. cmdStart logs a notice so
    // users who set the flag see the actual emission mode.
    const maCfgDir = join(projectRoot, '_Sprintpilot', 'modules', 'ma');
    mkdirSync(maCfgDir, { recursive: true });
    writeFileSync(
      join(maCfgDir, 'config.yaml'),
      'parallel_stories: true\nmax_parallel_stories: 2\n',
      'utf8',
    );
    runCli(['start']);
    const ledgerPath = join(
      projectRoot,
      '_bmad-output',
      'implementation-artifacts',
      'ledger.jsonl',
    );
    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
    const entries = lines.map((l) => JSON.parse(l));
    const notice = entries.find(
      (e) => e.detail && e.detail.parallel_stories_notice,
    );
    expect(notice).toBeDefined();
  });

  it('writes the ledger and state on start', () => {
    runCli(['start']);
    const statePath = join(
      projectRoot,
      '_bmad-output',
      'implementation-artifacts',
      'autopilot-state.yaml',
    );
    expect(readFileSync(statePath, 'utf8')).toContain('current_bmad_step: create_story');
    const ledgerPath = join(
      projectRoot,
      '_bmad-output',
      'implementation-artifacts',
      'ledger.jsonl',
    );
    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    // cmdStart emits multiple ledger entries before action_emitted
    // (lock_acquired, worktree_health_check) — find the action entry
    // rather than assuming it's first.
    const actionEntry = lines.map((l) => JSON.parse(l)).find((e) => e.kind === 'action_emitted');
    expect(actionEntry).toBeDefined();
  });

  it('halts cleanly with sprint_plan_corrupt instead of auto-rebuilding when sprint-plan.yaml is unparseable (v2.5.1)', () => {
    // Reproduce the observed scenario: a `- key: ...` entry was
    // appended OUTSIDE the stories: list, breaking the YAML structure.
    // Pre-2.5.1, this triggered shouldAutoDerive → invoke_skill:
    // sprintpilot-plan-sprint, which would discard the entire curated
    // plan. Post-fix, we emit a user_prompt halt with the parser error.
    const broken = [
      'schema_version: 1',
      'status: {}',
      'epics: []',
      'stories:',
      '  - key: a',
      'dependencies:',
      '  stories:',
      '    a:',
      '      depends_on: []',
      '  - key: rogue',                  // misindented — outside stories[]
      'cross_epic_deps: []',
      'overrides: []',
      '',
    ].join('\n');
    const impl = join(projectRoot, '_bmad-output', 'implementation-artifacts');
    mkdirSync(impl, { recursive: true });
    writeFileSync(join(impl, 'sprint-plan.yaml'), broken, 'utf8');
    const r = runCli(['start']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.action.type).toBe('user_prompt');
    expect(parsed.action.reason).toBe('sprint_plan_corrupt');
    expect(parsed.action.parser_error_code).toBe('parse_error');
    expect(parsed.action.file).toContain('sprint-plan.yaml');
    // CRITICAL: the destructive auto-rebuild action MUST NOT fire.
    expect(parsed.action.skill).toBeUndefined();
  });
});

describe('autopilot start — resume divergence handling (v2.2.30)', () => {
  // Real-world: user manually merged a story outside autopilot. Sprint-
  // status shows it `done`, but autopilot-state.yaml + the last halt's
  // fingerprint still reference that story. Pre-2.2.30 cmdStart returned
  // resume_divergence forever — there was no escape hatch short of
  // deleting state files manually.

  function seedDiverged(opts: { current_story: string; sprint_status_yaml: string }) {
    const artDir = join(projectRoot, '_bmad-output', 'implementation-artifacts');
    mkdirSync(artDir, { recursive: true });
    // Write a halt entry with a stale fingerprint so divergence.detect
    // fires (any non-empty fingerprint that doesn't match the live world
    // works for the test).
    writeFileSync(
      join(artDir, 'ledger.jsonl'),
      JSON.stringify({
        seq: 1,
        ts: '2026-01-01T00:00:00Z',
        kind: 'halt',
        phase: 'prepare_story_branch',
        reason: 'user_pause',
        fingerprint: { sprintStatusSha: 'stale', bmadTree: {}, branchHeads: {}, worktreePaths: [] },
      }) + '\n',
    );
    writeFileSync(
      join(artDir, 'autopilot-state.yaml'),
      `current_bmad_step: prepare_story_branch\ncurrent_story: ${opts.current_story}\n`,
    );
    writeFileSync(join(artDir, 'sprint-status.yaml'), opts.sprint_status_yaml);
  }

  it('auto-accepts divergence when persisted current_story is now `done` in sprint-status (v2.3.13: via state_reconciled)', () => {
    seedDiverged({
      current_story: '4-6-realm',
      sprint_status_yaml: 'development_status:\n  4-6-realm: done  # PR #42 merged manually\n  4-7-next: backlog\n',
    });
    const r = runCli(['start']);
    expect(r.status).toBe(0);
    // Should NOT emit resume_divergence — should proceed to action.
    expect(r.stdout).not.toContain('resume_divergence');
    // v2.3.13: the boot-time reconciliation step is now the primary
    // auto-accept mechanism. It runs BEFORE the legacy divergence path
    // and emits its own `state_reconciled` ledger entry + a fresh-baseline
    // resume entry. The legacy `divergence_accepted` resume no longer
    // fires (the divergence detector sees the freshly-baselined fingerprint
    // and finds nothing to flag).
    const ledgerPath = join(
      projectRoot,
      '_bmad-output',
      'implementation-artifacts',
      'ledger.jsonl',
    );
    const entries = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const reconciled = entries.find((e) => e.kind === 'state_reconciled');
    expect(reconciled).toBeDefined();
    const action = reconciled.detail.actions.find(
      (a: { kind: string; story?: string }) => a.kind === 'clear_completed_story',
    );
    expect(action).toBeDefined();
    expect(action.story).toBe('4-6-realm');
    // The reconcile path also stamps a fresh-baseline resume entry so
    // subsequent boots see no divergence.
    const rebaselined = entries.find(
      (e) =>
        e.kind === 'resume' &&
        e.divergence &&
        e.divergence.kind === 'state_reconciled' &&
        e.fingerprint,
    );
    expect(rebaselined).toBeDefined();
  });

  it('blocks with resume_divergence when persisted story is NOT yet done', () => {
    seedDiverged({
      current_story: '4-6-realm',
      sprint_status_yaml: 'development_status:\n  4-6-realm: in-progress\n',
    });
    const r = runCli(['start']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('resume_divergence');
    const parsed = JSON.parse(r.stdout);
    expect(parsed.kind).toBe('resume_divergence');
    expect(parsed.hint).toContain('--accept-divergence');
  });

  it('--accept-divergence bypasses the check unconditionally', () => {
    seedDiverged({
      current_story: '4-6-realm',
      sprint_status_yaml: 'development_status:\n  4-6-realm: in-progress\n',
    });
    const r = runCli(['start', '--accept-divergence']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('resume_divergence');
    const ledgerPath = join(
      projectRoot,
      '_bmad-output',
      'implementation-artifacts',
      'ledger.jsonl',
    );
    const entries = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const accepted = entries.find(
      (e) => e.kind === 'resume' && e.divergence && e.divergence.kind === 'divergence_accepted',
    );
    expect(accepted).toBeDefined();
    expect(accepted.divergence.reason).toBe('explicit_accept');
  });
});

describe('autopilot next', () => {
  it('emits the next planned action for the persisted phase', () => {
    runCli(['start']);
    const r = runCli(['next']);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.phase).toBe('create_story'); // hasn't moved yet
    expect(parsed.action.skill).toBe('bmad-create-story');
  });

  it('nano profile: `next` without prior `start` boots at NANO_QUICK_DEV', () => {
    // Regression: workflow.orchestrator.md tells the LLM to call `next`
    // directly without `start`, so the profile-aware initial phase must
    // apply in cmdNext too. Previously composeRuntimeState hardcoded
    // CREATE_STORY when persisted state was empty, defeating the nano
    // routing intent.
    writeFileSync(
      join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml'),
      'complexity_profile: nano\n',
      'utf8',
    );
    const r = runCli(['next']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.phase).toBe('nano_quick_dev');
    expect(parsed.action.skill).toBe('bmad-quick-dev');
  });
});

describe('autopilot record', () => {
  it('advances state on a successful signal', () => {
    runCli(['start']);
    // Need a story file in place for verify CREATE_STORY to pass.
    const storyDir = join(projectRoot, '_bmad-output', 'stories');
    mkdirSync(storyDir, { recursive: true });
    const storyPath = join(storyDir, 'S1.md');
    writeFileSync(
      storyPath,
      '---\nstory_key: S1\n---\n\n## Acceptance Criteria\n- AC1\n\n## Tasks\n- [ ] write tests\n',
      'utf8',
    );
    // Seed state.story_file_path so verify can find it.
    const statePath = join(
      projectRoot,
      '_bmad-output',
      'implementation-artifacts',
      'autopilot-state.yaml',
    );
    const existing = readFileSync(statePath, 'utf8');
    writeFileSync(
      statePath,
      `${existing}story_file_path: ${storyPath}\ncurrent_story: S1\n`,
      'utf8',
    );

    const signal = JSON.stringify({ status: 'success' });
    const r = runCli(['record', '--signal', signal]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.phase).toBe('check_readiness');
    expect(parsed.verdict).toBe('advanced');
  });

  it('rejects malformed signal JSON with exit 2', () => {
    runCli(['start']);
    const r = runCli(['record', '--signal', '{not json']);
    expect(r.status).toBe(2);
  });

  it('records failure → retry within budget', () => {
    runCli(['start']);
    const signal = JSON.stringify({
      status: 'failure',
      reason: 'broken',
      diagnosis: 'fixture missing',
      recoverable: true,
    });
    const r = runCli(['record', '--signal', signal]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.verdict).toBe('retry');
    expect(parsed.action.template_slots.prior_diagnosis).toBe('fixture missing');
  });

  it('user_input pause halts the loop on the same turn (Bug C regression)', () => {
    runCli(['start']);
    const signal = JSON.stringify({
      status: 'user_input',
      commands: [{ kind: 'pause', reason: 'dev 4-8 next' }],
    });
    const r = runCli(['record', '--signal', signal]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.verdict).toBe('halt');
    expect(parsed.action.type).toBe('halt');
    expect(parsed.action.reason).toBe('dev 4-8 next');
  });
});

describe('autopilot next: git_op decoration', () => {
  it('inlines git-plan steps into git_op actions (story_done emits commit + push)', () => {
    // This test specifically asserts the git decoration produces real
    // argv steps — so it must re-enable git for its scope (the suite-
    // wide fixture sets enabled=false to bypass PREPARE_STORY_BRANCH).
    // We seed the state file directly at story_done, so PREPARE_STORY_
    // BRANCH's own enabled=true behavior is never triggered.
    writeFileSync(
      join(projectRoot, '_Sprintpilot', 'modules', 'git', 'config.yaml'),
      'enabled: true\n',
      'utf8',
    );
    runCli(['start']);
    // Seed state at story_done so the next action is git_op:commit_and_push_story.
    const statePath = join(
      projectRoot,
      '_bmad-output',
      'implementation-artifacts',
      'autopilot-state.yaml',
    );
    const existing = readFileSync(statePath, 'utf8');
    writeFileSync(
      statePath,
      existing.replace(/current_bmad_step:.*$/m, 'current_bmad_step: story_done') +
        '\ncurrent_story: 1-1-game-engine\n',
      'utf8',
    );

    const r = runCli(['next']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.action.type).toBe('git_op');
    expect(parsed.action.op).toBe('commit_and_push_story');
    // The decoration must inline the planned argv steps so the LLM doesn't
    // have to interpret the abstract op — without this, live-LLM sessions
    // silently skipped `git push` after STORY_DONE.
    expect(Array.isArray(parsed.action.steps)).toBe(true);
    expect(parsed.action.steps.length).toBeGreaterThanOrEqual(2);
    const allArgs = parsed.action.steps.map((s: { args: string[] }) => s.args.join(' '));
    expect(allArgs.some((s: string) => s.startsWith('git add'))).toBe(true);
    expect(allArgs.some((s: string) => s.startsWith('git commit'))).toBe(true);
    expect(allArgs.some((s: string) => /^git push -u origin /.test(s))).toBe(true);
    expect(parsed.action.branch).toBe('story/1-1-game-engine');
  });
});

describe('autopilot state / report / status', () => {
  it('state prints persisted state as JSON', () => {
    runCli(['start']);
    const r = runCli(['state']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.current_bmad_step).toBe('create_story');
  });

  it('report prints a markdown summary', () => {
    runCli(['start']);
    const r = runCli(['report']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# Autopilot Session Report');
    expect(r.stdout).toContain('Ledger summary');
  });

  it('status --legacy prints the pre-v2.5.0 one-line summary', () => {
    runCli(['start']);
    const r = runCli(['status', '--legacy']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('story=- step=create_story');
  });

  it('status (default) prints structured JSON with the v2.5.0 fields', () => {
    runCli(['start']);
    const r = runCli(['status']);
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj).toMatchObject({
      story: null,
      current_phase: 'create_story',
      retry_count_this_phase: 0,
      verify_reject_count: 0,
      halt_active: false,
    });
    // Fields whose values vary but whose presence is the contract.
    expect(obj).toHaveProperty('time_in_phase_minutes');
    expect(obj).toHaveProperty('recent_events');
    expect(obj).toHaveProperty('quarantined_test_count', 0);
  });

  it('status --human renders a compact text block', () => {
    runCli(['start']);
    const r = runCli(['status', '--human']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('story=');
    expect(r.stdout).toContain('phase=create_story');
  });

  it('watch --once --no-tui renders a single frame and exits', () => {
    runCli(['start']);
    const r = runCli(['watch', '--once', '--no-tui']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Sprintpilot');
    expect(r.stdout).toContain('autopilot watch');
    expect(r.stdout).toContain('Recent ledger events');
  });
});

describe('autopilot help / unknown subcommand', () => {
  it('--help exits 0', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
  });

  it('unknown subcommand exits 2', () => {
    const r = runCli(['mystery']);
    expect(r.status).toBe(2);
  });

  it('no args prints help and exits 1', () => {
    const r = runCli([]);
    expect(r.status).toBe(1);
  });
});

// Helper: seed a sprint-status.yaml with the given keys/statuses.
function seedSprintStatus(entries: Record<string, string>) {
  const dir = join(projectRoot, '_bmad-output', 'implementation-artifacts');
  mkdirSync(dir, { recursive: true });
  const lines = ['development_status:'];
  for (const [k, v] of Object.entries(entries)) {
    lines.push(`  ${k}: ${v}`);
  }
  writeFileSync(join(dir, 'sprint-status.yaml'), lines.join('\n') + '\n', 'utf8');
}

function readPersistedState(): string {
  const p = join(projectRoot, '_bmad-output', 'implementation-artifacts', 'autopilot-state.yaml');
  return readFileSync(p, 'utf8');
}

describe('autopilot start --stories / --epic', () => {
  it('--stories <csv> queues the keys verbatim and persists story_queue', () => {
    seedSprintStatus({
      'epic-4': 'in-progress',
      '4-2b-foo': 'done',
      '4-5-bar': 'ready-for-dev',
      '4-8-baz': 'backlog',
    });
    const r = runCli(['start', '--stories', '4-8-baz,4-5-bar']);
    expect(r.status).toBe(0);
    const state = readPersistedState();
    expect(state).toMatch(/story_queue:.*4-8-baz/);
    expect(state).toMatch(/story_queue:.*4-5-bar/);
  });

  it('--stories rejects keys missing from sprint-status.yaml', () => {
    seedSprintStatus({ '4-5-bar': 'ready-for-dev' });
    const r = runCli(['start', '--stories', '4-5-bar,99-does-not-exist']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/not in sprint-status/);
    expect(r.stdout).toMatch(/99-does-not-exist/);
  });

  it('--stories rejects keys that are already done', () => {
    seedSprintStatus({ '4-2b-foo': 'done', '4-5-bar': 'ready-for-dev' });
    const r = runCli(['start', '--stories', '4-2b-foo,4-5-bar']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/already done.*4-2b-foo/);
  });

  it('--epic expands to all non-done stories of that epic, in order', () => {
    seedSprintStatus({
      'epic-4': 'in-progress',
      '4-2b-foo': 'done',
      '4-5-bar': 'ready-for-dev',
      '4-8-baz': 'backlog',
      '5-1-other-epic': 'backlog',
    });
    const r = runCli(['start', '--epic', '4']);
    expect(r.status).toBe(0);
    const state = readPersistedState();
    // 4-2b-foo done → skipped. 4-5-bar then 4-8-baz queued, in order.
    // epic-4 header itself filtered out by looksLikeStoryKey.
    expect(state).toMatch(/story_queue:.*4-5-bar.*4-8-baz/);
    expect(state).not.toMatch(/story_queue:.*epic-4/);
    expect(state).not.toMatch(/story_queue:.*5-1-other-epic/);
  });

  it('--epic with no remaining stories exits 2', () => {
    seedSprintStatus({ 'epic-4': 'done', '4-1-foo': 'done' });
    const r = runCli(['start', '--epic', '4']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/no non-done stories/);
  });

  it('--epic treats skipped/deferred/cancelled stories as terminal (v2.2.31)', () => {
    // Pre-2.2.31 only `done` counted as terminal. Users had no formal
    // way to mark a story out-of-scope without lying that it shipped,
    // and the orchestrator trapped them on next-story routing instead
    // of letting them close the epic with a retro.
    seedSprintStatus({
      'epic-4': 'in-progress',
      '4-1-foo': 'done',
      '4-2-bar': 'skipped',
      '4-3-baz': 'wont_do',
      '4-4-qux': 'cancelled',
      '4-5-quux': 'deferred',
      '4-6-abandoned-one': 'abandoned',
    });
    const r = runCli(['start', '--epic', '4']);
    // All stories are in terminal states → no remaining → exit 2.
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/no non-done stories/);
  });

  it('--stories / --epic without sprint-status.yaml exits 2 with planning hint', () => {
    const r = runCli(['start', '--stories', '4-1-foo']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/sprint-status\.yaml is missing or empty/);
    expect(r.stdout).toMatch(/sprint-planning/);
  });

  it('--stories refuses to overwrite an in-flight queue without --force', () => {
    seedSprintStatus({ '4-1-foo': 'ready-for-dev', '4-2-bar': 'ready-for-dev' });
    // First start: queue 4-1.
    expect(runCli(['start', '--stories', '4-1-foo']).status).toBe(0);
    // Second start without --force: error.
    const r = runCli(['start', '--stories', '4-2-bar']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/Sprint already in progress/);
  });

  it('--stories --force overwrites an in-flight queue and clears prior story identity', () => {
    seedSprintStatus({ '4-1-foo': 'ready-for-dev', '4-2-bar': 'ready-for-dev' });
    expect(runCli(['start', '--stories', '4-1-foo']).status).toBe(0);
    const r = runCli(['start', '--stories', '4-2-bar', '--force']);
    expect(r.status).toBe(0);
    const state = readPersistedState();
    expect(state).toMatch(/story_queue:.*4-2-bar/);
    expect(state).not.toMatch(/story_queue:.*4-1-foo/);
  });
});
