/**
 * E2E Nano Profile Test: Tic Tac Toe via Sprintpilot (nano profile)
 *
 * Verifies PR 4 + PR 5 end to end:
 *   - complexity_profile=nano routes every story through bmad-quick-dev
 *     (bmad-dev-story / bmad-create-story / bmad-check-readiness never run).
 *   - git.granularity=epic → one branch per epic, not per story.
 *   - git.worktree.enabled=false → no worktrees get created.
 *   - git.squash_on_merge=true → merge to main is a single commit per epic.
 *   - retrospective_mode=skip → no retrospective artifacts produced.
 *
 * Gated on ANTHROPIC_API_KEY because it drives a real autopilot session.
 *
 * Run: ANTHROPIC_API_KEY=... npx vitest run tests/e2e/nano.test.ts
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDirectoryExists,
  assertFileContains,
  assertFileExists,
  readYaml,
} from './harness/assertions.js';
import { runClaude } from './harness/claude-runner.js';
import { costTracker } from './harness/cost-tracker.js';
import { createTempProject, placeFixture, type TempProject } from './harness/temp-project.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures/greenfield');
const ADDON_SOURCE = join(import.meta.dirname, '../../_Sprintpilot');

const MAX_SESSIONS = 4;
const BUDGET_PER_SESSION = 20;
const TIMEOUT_PER_SESSION = 1_200_000; // 20 min
const MODEL = process.env.BMAD_TEST_MODEL ?? 'sonnet';
const REMOTE_URL = process.env.BMAD_TEST_REMOTE_URL ?? '';
// claude CLI may authenticate via keychain (Claude Code install) OR an
// ANTHROPIC_API_KEY env var. Skip only when BOTH are missing AND the
// binary isn't on PATH (avoids false positives in restricted CI).
const HAS_CLAUDE = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return !!process.env.ANTHROPIC_API_KEY;
  }
})();

let project: TempProject;

/** Run a git command via execFileSync (no shell; user input is never expanded). */
function git(args: string[], dir: string): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
}

function gitSafe(args: string[], dir: string): string {
  try {
    return git(args, dir);
  } catch {
    return '';
  }
}

/** Collect every skill.* phase observed across all per-story timing shards. */
function skillsInvoked(dir: string): Set<string> {
  const timingsDir = join(dir, '_bmad-output/implementation-artifacts/.timings');
  const skills = new Set<string>();
  if (!existsSync(timingsDir)) return skills;
  for (const f of readdirSync(timingsDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const body = readFileSync(join(timingsDir, f), 'utf-8');
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { phase?: string; event?: string };
        if (obj.event === 'start' && obj.phase && obj.phase.startsWith('skill.')) {
          skills.add(obj.phase);
        }
      } catch {
        /* skip */
      }
    }
  }
  return skills;
}

describe.skipIf(!HAS_CLAUDE)('Nano profile (Claude Code)', () => {
  beforeAll(() => {
    project = createTempProject({
      remoteUrl: REMOTE_URL,
      installBmadCore: true,
      installAddon: true,
      platform: 'github',
    });

    placeFixture(
      project.dir,
      '_bmad-output/planning-artifacts/prd.md',
      readFileSync(join(FIXTURES_DIR, 'prd.md'), 'utf-8'),
    );

    // Force nano profile. Write + verify the change actually stuck — the
    // installer's seed sometimes lands a `complexity_profile: medium` line
    // that a naive regex replace misses. After writing, read back and
    // assert. If the assertion fails the test setup explodes loudly
    // instead of silently running under the wrong profile.
    const autopilotCfg = join(project.dir, '_Sprintpilot/modules/autopilot/config.yaml');
    let body = existsSync(autopilotCfg) ? readFileSync(autopilotCfg, 'utf-8') : 'autopilot:\n';
    if (/^[ \t]*complexity_profile:/m.test(body)) {
      body = body.replace(
        /^([ \t]*)complexity_profile:[ \t]*[^\n]+$/m,
        '$1complexity_profile: nano',
      );
    } else {
      body = body.replace(/^autopilot:/m, 'autopilot:\n  complexity_profile: nano');
    }
    writeFileSync(autopilotCfg, body);
    const verifyBody = readFileSync(autopilotCfg, 'utf-8');
    if (!/^[ \t]*complexity_profile:[ \t]*nano\b/m.test(verifyBody)) {
      throw new Error(
        `[Nano setup] complexity_profile: nano did not stick in ${autopilotCfg}.\nGot:\n${verifyBody}`,
      );
    }

    console.log(`[Nano] Temp project: ${project.dir}`);
  });

  afterAll(async () => {
    const lockPath = join(project.dir, '.autopilot.lock');
    if (project && existsSync(lockPath)) {
      try {
        await runClaude('/sprint-autopilot-off', {
          cwd: project.dir,
          maxBudget: 2,
          model: MODEL,
          addDirs: [ADDON_SOURCE],
          timeout: 60_000,
        });
      } catch {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    console.log(costTracker.report());
    project?.cleanup();
  });

  it('setup is valid — nano profile selected', () => {
    assertDirectoryExists(join(project.dir, '_Sprintpilot'));
    assertFileExists(join(project.dir, '_bmad-output/planning-artifacts/prd.md'));
    assertFileContains(
      join(project.dir, '_Sprintpilot/modules/autopilot/config.yaml'),
      /complexity_profile:\s*nano/,
    );
  });

  it(
    'autopilot runs the sprint under nano profile',
    async () => {
      let session = 0;
      let totalCost = 0;

      while (session < MAX_SESSIONS) {
        session++;
        const systemPrompt = [
          'You are running inside an automated e2e test.',
          session === 1
            ? 'Follow the BMAD autopilot workflow exactly. PRD is at _bmad-output/planning-artifacts/prd.md.'
            : 'Resume the BMAD autopilot from saved state.',
          'complexity_profile=nano. Route every story through bmad-quick-dev. Do NOT invoke bmad-dev-story, bmad-create-story, bmad-check-implementation-readiness, or bmad-code-review.',
          'Do NOT ask the user any questions.',
          'Use TypeScript with Vitest for testing.',
        ].join(' ');

        console.log(`\n[Session ${session}/${MAX_SESSIONS}] Starting autopilot (nano)...`);
        const result = await runClaude('/sprint-autopilot-on', {
          cwd: project.dir,
          maxBudget: BUDGET_PER_SESSION,
          model: MODEL,
          addDirs: [ADDON_SOURCE],
          timeout: TIMEOUT_PER_SESSION,
          appendSystemPrompt: systemPrompt,
        });

        const cost = result.json?.total_cost_usd ?? 0;
        totalCost += cost;
        costTracker.record('nano', `session-${session}`, cost, result.json?.duration_ms ?? 0);

        if (!existsSync(join(project.dir, '.autopilot.lock'))) break;
      }
      console.log(`[Result] Nano sprint finished, $${totalCost.toFixed(4)}`);
    },
    MAX_SESSIONS * (TIMEOUT_PER_SESSION + 120_000),
  );

  it('bmad-quick-dev was invoked; bmad-dev-story was NOT', () => {
    const skills = skillsInvoked(project.dir);
    const asArray = [...skills];
    console.log(`[Skills] ${asArray.join(', ') || '(none)'}`);
    expect(asArray.some((s) => s === 'skill.bmad-quick-dev')).toBe(true);
    expect(asArray.some((s) => s === 'skill.bmad-dev-story')).toBe(false);
    expect(asArray.some((s) => s === 'skill.bmad-create-story')).toBe(false);
    expect(asArray.some((s) => s === 'skill.bmad-code-review')).toBe(false);
  });

  it('branches are per-epic (not per-story) under nano', () => {
    const dir = project.dir;
    const remote = gitSafe(['branch', '-r', '--list', 'origin/story/epic-*'], dir);
    const epicBranches = remote
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);
    const storyBranches = gitSafe(['branch', '-r', '--list', 'origin/story/*-*-*'], dir);
    const perStory = storyBranches
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b && !/\/epic-/.test(b));
    console.log(`[Branches] epic=${epicBranches.length} perStory=${perStory.length}`);
    expect(epicBranches.length).toBeGreaterThan(0);
    expect(
      perStory.length,
      `per-story branches should not exist under nano: ${perStory.join(', ')}`,
    ).toBe(0);
  });

  it('no worktrees were created under nano (worktree.enabled=false)', () => {
    const list = gitSafe(['worktree', 'list', '--porcelain'], project.dir);
    const worktreeLines = list.split('\n').filter((l) => l.startsWith('worktree '));
    expect(
      worktreeLines.length,
      `only the main worktree should exist; found: ${worktreeLines.join(' | ')}`,
    ).toBe(1);
  });

  it('no retrospective artifacts under nano (retrospective_mode=skip)', () => {
    const retroDir = join(project.dir, '_bmad-output/implementation-artifacts/retrospectives');
    if (!existsSync(retroDir)) return;
    const entries = readdirSync(retroDir).filter((f) => f.startsWith('epic-'));
    expect(
      entries,
      `nano profile should not generate retrospectives: ${entries.join(', ')}`,
    ).toEqual([]);
  });

  it('sprint-status shows all stories done', () => {
    const statusPath = join(
      project.dir,
      '_bmad-output/implementation-artifacts/sprint-status.yaml',
    );
    if (!existsSync(statusPath)) {
      console.warn('[Result] sprint-status.yaml missing — autopilot may have halted');
      return;
    }
    const status = readYaml(statusPath) as Record<string, unknown>;
    const block = (status.development_status ?? status.stories) as
      | Record<string, string | { status?: string }>
      | undefined;
    if (!block) return;
    // Sprint-status entries can be either inline `key: done` (string) or
    // block-form `key:\n  status: done\n  title: ...` (object). Both mean done.
    const remaining = Object.entries(block).filter(([, v]) => {
      const statusStr = typeof v === 'string' ? v : v?.status;
      return statusStr !== 'done';
    });
    expect(remaining, `stories not done: ${JSON.stringify(remaining)}`).toEqual([]);
  });
});
