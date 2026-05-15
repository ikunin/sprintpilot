import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Skill-timing integration: when `autopilot next` emits an `invoke_skill`
 * action, the CLI writes a `skill.<name>` start event to `.timings/<story>.jsonl`.
 * When `autopilot record --signal success` advances the phase, the CLI
 * writes the matching end event. This is what makes
 * `observedParallelism()` in the e2e harness see the orchestrator's work
 * without requiring the LLM to call log-timing.js itself.
 */

const CLI = join(__dirname, '..', '..', '..', '_Sprintpilot', 'bin', 'autopilot.js');
const REPO_ROOT = join(__dirname, '..', '..', '..');

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sp-autopilot-timing-'));

  // Seed _Sprintpilot/ into the temp project — the CLI's logSkillTiming
  // looks for `_Sprintpilot/scripts/log-timing.js` relative to projectRoot.
  const dest = join(projectRoot, '_Sprintpilot');
  mkdirSync(dest, { recursive: true });
  const src = join(REPO_ROOT, '_Sprintpilot');
  // Copy only what we need: scripts/, lib/, modules/.
  for (const sub of ['scripts', 'lib', 'modules']) {
    execFileSync('cp', ['-R', join(src, sub), join(dest, sub)]);
  }

  // Seed profile to medium so the orchestrator runs full flow.
  const cfgDir = join(projectRoot, '_Sprintpilot', 'modules', 'autopilot');
  writeFileSync(
    join(cfgDir, 'config.yaml'),
    'complexity_profile: medium\nautopilot:\n  execution_mode: orchestrator\n  phase_timings: true\n',
    'utf8',
  );
  // git.enabled: false bypasses PREPARE_STORY_BRANCH so the skill-timing
  // tests can keep asserting on CREATE_STORY/NANO_QUICK_DEV as the first
  // visible skill phase. composeRuntimeState's migration rule otherwise
  // bumps create_story → prepare_story_branch on every CLI call.
  writeFileSync(
    join(projectRoot, '_Sprintpilot', 'modules', 'git', 'config.yaml'),
    'enabled: false\n',
    'utf8',
  );
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function cli(args: string[]) {
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

function readTimings(story: string): { phase?: string; event?: string }[] {
  const p = join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    '.timings',
    `${story}.jsonl`,
  );
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as { phase?: string; event?: string };
      } catch {
        return {};
      }
    });
}

// Seed autopilot-state.yaml with `current_bmad_step: create_story` so the
// orchestrator skips the PREPARE_STORY_BRANCH precursor for tests that
// only care about skill-timing emission downstream. PREPARE_STORY_BRANCH
// emits a `git_op`, which does not produce a `skill.<name>` timing event
// — it's deliberately invisible to this test's assertion surface.
function bypassPrepareBranch() {
  const statePath = join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'autopilot-state.yaml',
  );
  const existing = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '';
  writeFileSync(statePath, `${existing}current_bmad_step: create_story\n`, 'utf8');
}

describe('autopilot CLI: skill timing events', () => {
  it('emits skill.bmad-create-story start on first `next`', () => {
    cli(['start']);
    bypassPrepareBranch();
    cli(['next']);
    const events = readTimings('sprint');
    const starts = events.filter((e) => e.event === 'start' && e.phase?.startsWith('skill.'));
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(starts[0].phase).toBe('skill.bmad-create-story');
  });

  it('emits skill.<name> end on phase-advancing `record success`', () => {
    cli(['start']);
    bypassPrepareBranch();
    // Seed a valid story file so verify accepts the success.
    const storyDir = join(projectRoot, '_bmad-output', 'stories');
    mkdirSync(storyDir, { recursive: true });
    const storyPath = join(storyDir, 'S1.md');
    writeFileSync(
      storyPath,
      '---\nstory_key: S1\nreadiness: ready\n---\n\n## Acceptance Criteria\n- AC1\n\n## Tasks\n- [ ] x\n',
      'utf8',
    );
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

    cli(['record', '--signal', JSON.stringify({ status: 'success' })]);
    // log-timing.js requires lowercase story keys; autopilot sanitizes
    // 'S1' → 's1' before writing.
    const sprintEvents = readTimings('sprint');
    const storyEvents = readTimings('s1');
    const allEvents = [...sprintEvents, ...storyEvents];
    const ends = allEvents.filter((e) => e.event === 'end' && e.phase?.startsWith('skill.'));
    expect(ends.length).toBeGreaterThanOrEqual(1);
  });

  it('skips timing when autopilot.phase_timings: false', () => {
    const cfg = join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml');
    writeFileSync(
      cfg,
      'complexity_profile: medium\nautopilot:\n  execution_mode: orchestrator\n  phase_timings: false\n',
      'utf8',
    );
    cli(['start']);
    cli(['next']);
    // legacy log-timing.js itself respects phase_timings, so when off, no
    // file should be created.
    const sprintEvents = readTimings('sprint');
    expect(sprintEvents.length).toBe(0);
  });
});
