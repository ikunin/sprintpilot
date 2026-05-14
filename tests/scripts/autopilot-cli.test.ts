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
    const entry = JSON.parse(lines[0]);
    expect(entry.kind).toBe('action_emitted');
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
});

describe('autopilot next: git_op decoration', () => {
  it('inlines git-plan steps into git_op actions (story_done emits commit + push)', () => {
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

  it('status prints a one-line summary', () => {
    runCli(['start']);
    const r = runCli(['status']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('story=- step=create_story');
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
