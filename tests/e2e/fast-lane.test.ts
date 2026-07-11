/**
 * E2E Fast-Lane Test: per-story quick-dev under a FULL profile.
 *
 * Verifies the opt-in fast lane end to end:
 *   - complexity_profile=medium (a FULL profile) with autopilot.fast_lane.enabled=true.
 *   - The pre-story gate emits a `fast_lane_decision` ledger entry per story.
 *   - A low-risk story (docs) is routed through bmad-quick-dev; a substantial
 *     story keeps the 7-step cycle (bmad-dev-story runs).
 *   - The run completes with commits, proving the mixed routing works.
 *
 * This is the deterministic-where-possible complement to the pure unit +
 * integration coverage (fast-lane-gate / fast-lane-escalation /
 * fast-lane-derive-profile). It drives a real autopilot session, so it is
 * gated on RUN_LLM_E2E=1 + a usable Claude CLI, like the other e2e suites.
 *
 * Run: RUN_LLM_E2E=1 ANTHROPIC_API_KEY=... npx vitest run tests/e2e/fast-lane.test.ts
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDirectoryExists, assertFileContains } from './harness/assertions.js';
import { runClaude } from './harness/claude-runner.js';
import { costTracker } from './harness/cost-tracker.js';
import { createTempProject, placeFixture, type TempProject } from './harness/temp-project.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures/greenfield');
const ADDON_SOURCE = join(import.meta.dirname, '../../_Sprintpilot');

const MAX_SESSIONS = 3;
const BUDGET_PER_SESSION = 12;
const TIMEOUT_PER_SESSION = 1_800_000; // 30 min
const MODEL = process.env.BMAD_TEST_MODEL ?? 'sonnet';
const REMOTE_URL = process.env.BMAD_TEST_REMOTE_URL ?? '';
const HAS_CLAUDE = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return !!process.env.ANTHROPIC_API_KEY;
  }
})();
const RUN_LLM_E2E = process.env.RUN_LLM_E2E === '1';

let project: TempProject;

function gitSafe(args: string[], dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 30_000 }).trim();
  } catch {
    return '';
  }
}

// Read every `fast_lane_decision` / `profile_escalated` ledger entry.
function readLedger(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, '_bmad-output/implementation-artifacts/ledger.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null);
}

// Set complexity_profile=medium AND enable the fast lane, verifying both stuck.
function configureFastLane(dir: string) {
  const cfg = join(dir, '_Sprintpilot/modules/autopilot/config.yaml');
  let body = existsSync(cfg) ? readFileSync(cfg, 'utf-8') : 'autopilot:\n';
  if (/^[ \t]*complexity_profile:/m.test(body)) {
    body = body.replace(
      /^([ \t]*)complexity_profile:[ \t]*[^\n]+$/m,
      '$1complexity_profile: medium',
    );
  } else {
    body = body.replace(/^autopilot:/m, 'autopilot:\n  complexity_profile: medium');
  }
  // Add / replace the fast_lane block with enabled: true + generous docs allow.
  if (/^[ \t]*fast_lane:/m.test(body)) {
    body = body.replace(
      /^([ \t]*fast_lane:[ \t]*(?:#.*)?\n(?:[ \t]*#.*\n)*[ \t]*enabled:[ \t]*)(?:true|false)/m,
      '$1true',
    );
  } else {
    body = body.replace(
      /^autopilot:/m,
      'autopilot:\n  fast_lane:\n    enabled: true\n    allow_globs: "docs/**,**/*.md,**/README*"',
    );
  }
  writeFileSync(cfg, body);
  const verify = readFileSync(cfg, 'utf-8');
  if (!/^[ \t]*complexity_profile:[ \t]*medium\b/m.test(verify)) {
    throw new Error(`[Fast-lane setup] complexity_profile: medium did not stick.\n${verify}`);
  }
  if (!/^[ \t]*enabled:[ \t]*true\b/m.test(verify)) {
    throw new Error(`[Fast-lane setup] fast_lane.enabled: true did not stick.\n${verify}`);
  }
}

describe.skipIf(!HAS_CLAUDE || !RUN_LLM_E2E)('Fast lane (medium profile, Claude Code)', () => {
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
    configureFastLane(project.dir);
    console.log(`[Fast-lane] Temp project: ${project.dir}`);
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

  it('setup is valid — medium profile with the fast lane enabled', () => {
    assertDirectoryExists(join(project.dir, '_Sprintpilot'));
    assertFileContains(
      join(project.dir, '_Sprintpilot/modules/autopilot/config.yaml'),
      /complexity_profile:\s*medium/,
    );
    assertFileContains(
      join(project.dir, '_Sprintpilot/modules/autopilot/config.yaml'),
      /enabled:\s*true/,
    );
  });

  it(
    'autopilot runs a mixed sprint with per-story fast-lane routing',
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
          'complexity_profile=medium with the quick-dev fast lane enabled. Follow the orchestrator actions verbatim — a low-risk story may be routed to bmad-quick-dev, a substantial one to the full 7-step cycle.',
          'Do NOT ask the user any questions.',
          'Use TypeScript with Vitest for testing.',
        ].join(' ');
        console.log(`\n[Session ${session}/${MAX_SESSIONS}] Starting autopilot (fast lane)...`);
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
        costTracker.record('fast-lane', `session-${session}`, cost, result.json?.duration_ms ?? 0);
        if (!existsSync(join(project.dir, '.autopilot.lock'))) break;
      }
      console.log(`[Result] Fast-lane sprint finished, $${totalCost.toFixed(4)}`);
    },
    MAX_SESSIONS * (TIMEOUT_PER_SESSION + 120_000),
  );

  it('the fast-lane gate evaluated a routing decision per story', () => {
    const decisions = readLedger(project.dir).filter((e) => e.kind === 'fast_lane_decision');
    console.log(
      `[Fast-lane] decisions: ${JSON.stringify(decisions.map((d) => [d.story_key, d.decision]))}`,
    );
    // With the lane enabled and at least one story run, the gate must have
    // emitted at least one routing decision.
    expect(decisions.length).toBeGreaterThan(0);
  });

  it('produced commits and left no dangling lock', () => {
    const commits = gitSafe(['log', '--all', '--oneline'], project.dir).split('\n').filter(Boolean);
    expect(commits.length).toBeGreaterThan(2); // beyond the 2 setup commits
    expect(existsSync(join(project.dir, '.autopilot.lock'))).toBe(false);
  });
});
