/**
 * E2E Sudoku Test: Modern web Sudoku via Sprintpilot with parallel dispatch
 *
 * Exercises the full 2.0.x stack end-to-end:
 *   - complexity_profile: medium
 *   - parallel_stories: true (PR 11)
 *   - auto_infer_dependencies: true (2.0.2)
 *   - sprint-finalize-pending fresh-context handoff (2.0.1)
 *   - Step 10 CRITICAL 1-7 deterministic cleanup
 *
 * Sprint shape (from PRD):
 *   1-1 engine          — foundation
 *   1-2 generator+solver — depends on 1-1 only ──┐
 *   1-3 UI shell         — depends on 1-1 only ──┤  parallel layer
 *   1-4 game wiring      — depends on 1-2 AND 1-3
 *
 * The auto-inferred dependencies.yaml should produce 3 layers; layer 2
 * widens to width >= 2, exercising parallel dispatch.
 *
 * Cleanup behavior — IMPORTANT:
 *   This test does NOT clean up the generated project on completion. It
 *   prints the project dir, the dev server URL, and explicit cleanup
 *   commands at the end. The user kills the dev server + deletes the
 *   project dir manually after testing the game in the browser.
 *
 *   Set SUDOKU_AUTO_CLEANUP=1 to opt back into automatic cleanup (the
 *   normal e2e behavior).
 *
 * Run: BMAD_TEST_REMOTE_URL=git@github.com:you/sudoku-test.git \
 *      npx vitest run tests/e2e/sudoku.test.ts
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
import {
  getLatestStoryBranch as getLatestStoryBranchShared,
  getWorktreePath as getWorktreePathShared,
} from './harness/git-utils.js';
import { createTempProject, placeFixture, type TempProject } from './harness/temp-project.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures/sudoku');
const ADDON_SOURCE = join(import.meta.dirname, '../../_Sprintpilot');

const MAX_SESSIONS = 5;
const BUDGET_PER_SESSION = 10;
const TIMEOUT_PER_SESSION = 1_800_000; // 30 min
const MODEL = process.env.BMAD_TEST_MODEL ?? 'sonnet';
const REMOTE_URL = process.env.BMAD_TEST_REMOTE_URL ?? '';
const AUTO_CLEANUP = process.env.SUDOKU_AUTO_CLEANUP === '1';

const HAS_CLAUDE = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return !!process.env.ANTHROPIC_API_KEY;
  }
})();
// Live-LLM tests are off by default — opt in via RUN_LLM_E2E=1.
// sudoku is part of the broader suite and also requires RUN_LLM_E2E_FULL=1
// (canonical fast test is nano.test.ts).
const RUN_LLM_E2E = process.env.RUN_LLM_E2E === '1';
const RUN_LLM_E2E_FULL = process.env.RUN_LLM_E2E_FULL === '1';
const LLM_E2E_ENABLED = RUN_LLM_E2E && RUN_LLM_E2E_FULL;

let project: TempProject;
let devServer: ChildProcess | null = null;
let devServerUrl: string | null = null;
let devServerLogPath: string | null = null;

// Shared with greenfield via tests/e2e/harness/git-utils.ts. The shared
// version filters branch matches against the current sprint's story keys
// (parsed from sprint-status.yaml) — a leftover branch from a prior run on
// a shared remote will NOT be picked even if it has a newer committerdate.
const getLatestStoryBranch = (dir: string) => getLatestStoryBranchShared(dir);
const getWorktreePath = (dir: string, branch: string) => getWorktreePathShared(dir, branch);

/** Walk timing shards for evidence of overlapping implementation phases. */
const PARALLEL_RELEVANT_PHASES = new Set([
  'skill.bmad-dev-story',
  'skill.bmad-create-story',
  'skill.bmad-quick-dev',
  'skill.bmad-code-review',
  'skill.bmad-check-implementation-readiness',
]);

function observedParallelism(dir: string): { max: number; examples: string[] } {
  const timingsDir = join(dir, '_bmad-output/implementation-artifacts/.timings');
  if (!existsSync(timingsDir)) return { max: 0, examples: [] };
  interface Event {
    event: 'start' | 'end';
    story: string;
    phase: string;
    ts: number;
  }
  const events: Event[] = [];
  for (const f of readdirSync(timingsDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const body = readFileSync(join(timingsDir, f), 'utf-8');
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as {
          event?: string;
          story?: string;
          phase?: string;
          ts?: string;
        };
        if (!obj.event || !obj.story || !obj.phase || !obj.ts) continue;
        if (obj.event !== 'start' && obj.event !== 'end') continue;
        events.push({
          event: obj.event as 'start' | 'end',
          story: obj.story,
          phase: obj.phase,
          ts: Date.parse(obj.ts),
        });
      } catch {
        /* skip corrupt */
      }
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  const open = new Map<string, Event>();
  let max = 0;
  const examples: string[] = [];
  for (const ev of events) {
    const key = `${ev.story}::${ev.phase}`;
    if (ev.event === 'start') {
      open.set(key, ev);
      const active = new Set(
        [...open.values()].filter((o) => PARALLEL_RELEVANT_PHASES.has(o.phase)).map((o) => o.story),
      );
      if (active.size > max) {
        max = active.size;
        if (max >= 2) examples.push([...active].sort().join('+'));
      }
    } else {
      open.delete(key);
    }
  }
  return { max, examples: [...new Set(examples)] };
}

function findCodeDir(dir: string): string {
  const latestBranch = getLatestStoryBranch(dir);
  if (latestBranch) {
    const localBranch = latestBranch.replace(/^origin\//, '');
    const wt = getWorktreePath(dir, localBranch);
    if (wt && existsSync(join(wt, 'package.json'))) return wt;
    try {
      execFileSync('git', ['-C', dir, 'checkout', latestBranch], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
    } catch {
      /* */
    }
  }
  return dir;
}

/** Wait for vite to print its dev server URL to the log file. */
async function waitForDevUrl(logPath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const body = readFileSync(logPath, 'utf-8');
      const m = body.match(/(https?:\/\/(?:localhost|127\.0\.0\.1)[^\s]*)/);
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`dev server URL not detected within ${timeoutMs}ms — see ${logPath}`);
}

describe.skipIf(!HAS_CLAUDE || !LLM_E2E_ENABLED)('Sudoku web game (parallel dispatch)', () => {
  beforeAll(() => {
    project = createTempProject({
      remoteUrl: REMOTE_URL,
      installBmadCore: true,
      installAddon: true,
      platform: REMOTE_URL ? 'github' : 'git_only',
    });

    placeFixture(
      project.dir,
      '_bmad-output/planning-artifacts/prd.md',
      readFileSync(join(FIXTURES_DIR, 'prd.md'), 'utf-8'),
    );

    // Force medium profile + enable parallel dispatch + auto-infer deps.
    const autopilotCfg = join(project.dir, '_Sprintpilot/modules/autopilot/config.yaml');
    let body = existsSync(autopilotCfg) ? readFileSync(autopilotCfg, 'utf-8') : 'autopilot:\n';
    if (!/complexity_profile:/.test(body)) {
      body = body.replace(/^autopilot:/m, 'autopilot:\n  complexity_profile: medium');
    }
    if (!/^\s*auto_infer_dependencies:/m.test(body)) {
      body = body.replace(/^autopilot:/m, 'autopilot:\n  auto_infer_dependencies: true');
    } else if (/^\s*auto_infer_dependencies:\s*false/m.test(body)) {
      body = body.replace(/^(\s*auto_infer_dependencies:\s*)false/m, '$1true');
    }
    writeFileSync(autopilotCfg, body);

    // Flip parallel_stories on in ma/config.yaml.
    const maCfg = join(project.dir, '_Sprintpilot/modules/ma/config.yaml');
    if (existsSync(maCfg)) {
      let ma = readFileSync(maCfg, 'utf-8');
      if (/^\s*parallel_stories\s*:\s*true\b/m.test(ma)) {
        // already true
      } else if (/^\s*parallel_stories\s*:\s*\S+/m.test(ma)) {
        ma = ma.replace(/^(\s*parallel_stories\s*:\s*)\S+/m, '$1true');
      } else {
        ma = ma.replace(/\s*$/, '') + '\nparallel_stories: true\n';
      }
      writeFileSync(maCfg, ma);
    }

    console.log(`[Sudoku] Temp project: ${project.dir}`);
  });

  afterAll(async () => {
    if (devServer && AUTO_CLEANUP) {
      try {
        process.kill(-devServer.pid!, 'SIGTERM');
      } catch {
        /* */
      }
    }
    if (project && existsSync(join(project.dir, '.autopilot.lock'))) {
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
          rmSync(join(project.dir, '.autopilot.lock'), { force: true });
        } catch {
          /* */
        }
      }
    }
    console.log(costTracker.report());
    if (AUTO_CLEANUP) {
      project?.cleanup();
    } else {
      console.log(`\n[Sudoku] Auto-cleanup OFF — project preserved at: ${project.dir}`);
      console.log('[Sudoku] To enable cleanup, re-run with SUDOKU_AUTO_CLEANUP=1');
    }
  });

  it('setup is valid', () => {
    assertDirectoryExists(join(project.dir, '_Sprintpilot'));
    assertDirectoryExists(join(project.dir, '_bmad'));
    assertFileExists(join(project.dir, '_bmad-output/planning-artifacts/prd.md'));
    assertFileContains(
      join(project.dir, '_Sprintpilot/modules/autopilot/config.yaml'),
      /auto_infer_dependencies:\s*true/,
    );
    assertFileContains(
      join(project.dir, '_Sprintpilot/modules/ma/config.yaml'),
      /parallel_stories:\s*true/,
    );
  });

  it(
    'autopilot builds working sudoku game with parallel dispatch',
    async () => {
      let session = 0;
      let totalCost = 0;
      const stateFilePath = join(
        project.dir,
        '_bmad-output/implementation-artifacts/autopilot-state.yaml',
      );
      const readCurrentStep = (): string | null => {
        if (!existsSync(stateFilePath)) return null;
        try {
          return (readYaml(stateFilePath)?.current_bmad_step as string | null) ?? null;
        } catch {
          return null;
        }
      };

      while (session < MAX_SESSIONS) {
        session++;

        const lockHeld = existsSync(join(project.dir, '.autopilot.lock'));
        const savedStep = readCurrentStep();
        if (!lockHeld && savedStep === 'sprint-complete') {
          console.log(`[Session ${session}] Sprint-complete state reached — done`);
          break;
        }
        if (!lockHeld && savedStep === null && !existsSync(stateFilePath) && session > 1) {
          console.log(`[Session ${session}] State cleaned + lock released — done`);
          break;
        }
        if (!lockHeld && savedStep === 'sprint-finalize-pending') {
          console.log(
            `[Session ${session}] sprint-finalize-pending detected — running fresh-context finalize`,
          );
        }

        const systemPrompt = [
          'You are running inside an automated e2e test.',
          session === 1
            ? 'Follow the BMAD autopilot workflow exactly. PRD is at _bmad-output/planning-artifacts/prd.md.'
            : 'Resume the BMAD autopilot from saved state.',
          'You are Claude Code. ma.parallel_stories is true and autopilot.auto_infer_dependencies is true.',
          'When the DAG resolver widens a layer to >1 story, spawn concurrent sub-agents (Agent tool) for that layer.',
          'Do NOT ask the user any questions — resolve all decisions autonomously.',
          'Tech: TypeScript + Vite + Vitest. Vanilla DOM, no UI framework. Use happy-dom for DOM unit tests.',
          'Source layout: src/engine/ (pure logic), src/ui/ (DOM), src/styles/ (css), src/main.ts entry, index.html for Vite.',
          'package.json scripts: dev (vite), build (tsc + vite build), test (vitest run). Listen on default port 5173.',
        ].join(' ');

        console.log(`\n[Session ${session}/${MAX_SESSIONS}] Starting autopilot...`);
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
        costTracker.record('sudoku', `session-${session}`, cost, result.json?.duration_ms ?? 0);

        const status = result.timedOut
          ? 'TIMED_OUT'
          : result.json?.is_error
            ? 'ERROR'
            : result.exitCode === 0
              ? 'OK'
              : `EXIT_${result.exitCode}`;
        console.log(
          `[Session ${session}] ${status} | Cost: $${cost.toFixed(4)} | Total: $${totalCost.toFixed(4)} | turns=${result.json?.num_turns ?? '?'}`,
        );
        if (result.json?.result) {
          const msg = result.json.result.replace(/\s+/g, ' ').slice(0, 400);
          console.log(
            `[Session ${session}] LLM final: ${msg}${result.json.result.length > 400 ? '…' : ''}`,
          );
        }

        if (result.json?.is_error) {
          console.error(`[Session ${session}] Error: ${result.json.result}`);
          if (/rate.?limit/i.test(result.json.result ?? '')) break;
        }
      }

      console.log(
        `\n[Sudoku] Autopilot loop done after ${session} sessions, $${totalCost.toFixed(4)}`,
      );
    },
    MAX_SESSIONS * (TIMEOUT_PER_SESSION + 120_000),
  );

  it('dependencies.yaml was auto-inferred (AUTO-INFERRED marker present)', () => {
    const depsPath = join(project.dir, '_Sprintpilot/sprints/dependencies.yaml');
    if (!existsSync(depsPath)) {
      throw new Error(
        `dependencies.yaml missing at ${depsPath} — auto_infer_dependencies should have produced it`,
      );
    }
    const body = readFileSync(depsPath, 'utf-8');
    expect(body.split('\n')[0].trim()).toBe(
      '# AUTO-INFERRED — regenerate via infer-dependencies.js',
    );
    expect(body).toMatch(/^# Hash: [0-9a-f]{12}$/m);
    expect(body).toMatch(/depends_on: \[".*"\]/);
  });

  it('sprint-status shows all stories done', () => {
    const statusPath = join(
      project.dir,
      '_bmad-output/implementation-artifacts/sprint-status.yaml',
    );
    if (!existsSync(statusPath)) {
      throw new Error('sprint-status.yaml missing — autopilot did not complete planning');
    }
    const status = readYaml(statusPath) as Record<string, unknown>;
    const block = (status.development_status ?? status.stories) as
      | Record<string, unknown>
      | undefined;
    expect(block, 'development_status / stories block missing').toBeTruthy();
    const remaining = Object.entries(block ?? {}).filter(
      ([, v]) => (typeof v === 'string' ? v : (v as { status?: string })?.status) !== 'done',
    );
    expect(remaining, `stories not done: ${JSON.stringify(remaining)}`).toEqual([]);
  });

  it('starts dev server and prints URL — game is ready for manual play', async () => {
    const codeDir = findCodeDir(project.dir);
    console.log(`[Sudoku] Code directory: ${codeDir}`);

    const pkgPath = join(codeDir, 'package.json');
    if (!existsSync(pkgPath)) {
      throw new Error(
        `No package.json at ${codeDir} — autopilot may not have produced a buildable project`,
      );
    }

    // Install deps if needed (npm install with no user-provided arguments — safe).
    if (!existsSync(join(codeDir, 'node_modules'))) {
      console.log('[Sudoku] Installing dependencies (npm install)...');
      execFileSync('npm', ['install'], { cwd: codeDir, timeout: 180_000, stdio: 'inherit' });
    }

    // Start the dev server detached so it survives the test exiting.
    const logDir = join(tmpdir(), `sudoku-dev-${Date.now()}`);
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, 'dev.log');
    const errPath = join(logDir, 'dev.err');
    devServerLogPath = logPath;

    console.log('[Sudoku] Starting dev server (detached)...');
    const child = spawn('npm', ['run', 'dev'], {
      cwd: codeDir,
      detached: true,
      stdio: ['ignore', openSync(logPath, 'w'), openSync(errPath, 'w')],
    });
    child.unref();
    devServer = child;

    try {
      devServerUrl = await waitForDevUrl(logPath, 30_000);
    } catch (err) {
      const errBody = existsSync(errPath) ? readFileSync(errPath, 'utf-8').slice(0, 1500) : '';
      const logBody = existsSync(logPath) ? readFileSync(logPath, 'utf-8').slice(0, 1500) : '';
      throw new Error(
        `dev server failed to start.\nstdout:\n${logBody}\nstderr:\n${errBody}\noriginal: ${(err as Error).message}`,
      );
    }

    const sourcesDir = join(codeDir, 'src');
    const artifactsDir = join(project.dir, '_bmad-output');

    const banner = '═'.repeat(75);
    console.log(`
${banner}
SUDOKU GAME READY — open the URL in your browser
${banner}
URL:                ${devServerUrl}
Project root:       ${project.dir}
Code directory:     ${codeDir}
Sources:            ${sourcesDir}
Artifacts:          ${artifactsDir}
Sprint status:      ${join(artifactsDir, 'implementation-artifacts/sprint-status.yaml')}
Inferred DAG:       ${join(project.dir, '_Sprintpilot/sprints/dependencies.yaml')}
Dev server PID:     ${child.pid}
Dev server stdout:  ${logPath}
Dev server stderr:  ${errPath}

The dev server is running detached and will survive this test exiting.

When you're done testing, run BOTH commands manually:
  kill ${child.pid}
  rm -rf "${project.dir}"
${banner}
      `);

    // Sanity-check: the game's own test suite runs (advisory only).
    try {
      const testOut = execFileSync('npx', ['vitest', 'run'], {
        cwd: codeDir,
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const testsMatch = testOut.match(/Tests\s+(\d+)\s+passed/);
      if (testsMatch) {
        console.log(`[Sudoku] In-project test suite: ${testsMatch[1]} passed`);
      }
    } catch (err) {
      console.warn(
        `[Sudoku] In-project test suite did NOT pass cleanly: ${(err as Error).message?.slice(0, 200)}`,
      );
    }
  }, 600_000);

  it('logs parallel-dispatch evidence (advisory)', () => {
    const par = observedParallelism(project.dir);
    console.log(
      `[Sudoku] Observed parallelism: max=${par.max}, examples=${par.examples.join('|') || '(none)'}`,
    );
    // Advisory only — the LLM may run sequentially even when the DAG permits
    // parallelism. The hard contract is the AUTO-INFERRED sidecar (asserted earlier).
  });
});
